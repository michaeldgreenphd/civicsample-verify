"""Fictional evidence only; every provider/store call below is a local fake."""
from __future__ import annotations

import copy
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mapping_runner", Path(__file__).with_name("runner.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def fixture():
    guide = "Fictional guide: assess the displayed mapping from the supplied trial evidence."
    units = []
    for i in range(100):
        unit_id = f"SYN-AI-{i + 1:03d}"
        subtype = i == 0
        units.append({
            "unit_id": unit_id,
            "packet": {"unit": {"unit_id": unit_id, "mode": "FORMAL", "family": "SG" if subtype else "AREA",
                                  "category": "SYNTHETIC", "unit_role": "SUBGROUP" if subtype else "PRIMARY",
                                  "mapping_code": "SYNTHETIC", "mapping_label": "Fictional therapeutic area",
                                  "assignment_code": "D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY" if subtype else "SYNTHETIC_ASSIGNED",
                                  "assignment_status": "ASSIGNED", "display_text": "Fictional assigned category"},
                       "trial": {"nct_id": "SYNTHETIC-REGISTRY-REFERENCE", "brief_title": "Fictional study",
                                 "brief_summary": "Fictional evidence; not a study record."}, "notices": ["Synthetic test"]},
            "display": {"title": "Fictional category", "context": None, "assertion": "Included",
                        "question": "Does the fictional evidence fit this category?", "polarity": None, "basis": "Fictional mapping"},
            "answer_options": [{"code": a, "label": a.title(), "meaning": "Fictional response meaning"} for a in runner.ANSWERS],
            "reason_codes": [{"code": "OTHER_SPECIFIED", "meaning": "Explain the fictional disagreement"}],
            "subtype_required": subtype,
        })
    return {"format": runner.FORMAT, "guide": {"text": guide, "sha256": runner.sha(guide.encode()), "profile_id": "SYNTHETIC-TEST"},
            "source": {"app_commit": "a" * 40, "sample_sha256": "b" * 64, "prepared_import_sha256": "c" * 64}, "units": units}


def response(request, *, answer="AGREE", reason=None, note="", subtype=None):
    return {"id": "synthetic-message", "type": "message", "model": request["model"], "stop_reason": "end_turn",
            "content": [{"type": "text", "text": json.dumps({"answer": answer, "reason_code": reason, "note": note,
                                                            "uncertain": False, "diabetes_subtype": subtype})}],
            "usage": {"input_tokens": 100, "output_tokens": 30}}


class FakeProvider:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback
        self.checked = 0

    def check_models(self):
        self.checked += 1

    def message(self, request):
        self.calls.append(copy.deepcopy(request))
        if self.callback:
            return self.callback(request)
        has_subtype = request["output_config"]["format"]["schema"]["properties"]["diabetes_subtype"]["type"] == "string"
        return response(request, subtype="TYPE_2_NOT_STATED" if has_subtype else None)


class MappingRunnerTests(unittest.TestCase):
    def setUp(self):
        self.bundle = fixture()
        self.raw = runner.encode(self.bundle)
        self.digest = runner.sha(self.raw)
        self.cap = runner.cap_micro("95")
        self.state = runner.new_state(self.digest, self.cap, "SYNTHETIC-APPROVAL")

    def run_fake(self, provider=None, persist=lambda _: None):
        return runner.run(self.bundle, self.digest, self.state, self.cap, "SYNTHETIC-APPROVAL", provider or FakeProvider(), persist)

    def test_valid_bundle_and_offline_plan(self):
        parsed = runner.validate_bundle(self.raw, self.digest)
        with patch.object(runner.Provider, "call", side_effect=AssertionError("network")):
            plan = runner.dry_run(parsed)
        self.assertEqual(plan["planned_requests"], 300)
        self.assertEqual(plan["paid_requests"], 0)
        self.assertGreater(plan["reserved_upper_bound_usd"], 0)

    def test_hash_and_duplicate_keys_refused(self):
        with self.assertRaisesRegex(runner.Refused, "input_digest_mismatch"):
            runner.validate_bundle(self.raw, "0" * 64)
        with self.assertRaises(runner.Refused):
            runner.decode(b'{"value":1,"value":2}')
        with self.assertRaises(runner.Refused):
            runner.decode(b'{"value":NaN}')

    def test_unknown_hidden_fields_refused(self):
        for location in ("root", "unit", "trial", "display"):
            b = copy.deepcopy(self.bundle)
            target = b if location == "root" else b["units"][0]
            if location == "trial":
                target = target["packet"]["trial"]
            if location == "display":
                target = target["display"]
            target["another_reviewers_answer"] = "must not be passed"
            raw = runner.encode(b)
            with self.subTest(location=location), self.assertRaises(runner.Refused):
                runner.validate_bundle(raw, runner.sha(raw))

    def test_exact_100_unique_units_and_subtype_required(self):
        mutations = [lambda b: b["units"].pop(), lambda b: b["units"].__setitem__(1, copy.deepcopy(b["units"][0])),
                     lambda b: b["units"][0].__setitem__("subtype_required", False)]
        for mutate in mutations:
            b = copy.deepcopy(self.bundle)
            mutate(b)
            raw = runner.encode(b)
            with self.assertRaises(runner.Refused):
                runner.validate_bundle(raw, runner.sha(raw))

    def test_same_guide_and_evidence_for_every_arm_no_tools_or_sampling(self):
        requests = [runner.request_for(self.bundle, self.bundle["units"][0], m) for m in runner.MODELS]
        bodies = []
        for req in requests:
            self.assertNotIn("tools", req)
            self.assertNotIn("temperature", req)
            self.assertIn(runner.SUBTYPE_QUESTION, req["messages"][0]["content"])
            self.assertNotIn("sample_sha256", json.dumps(req))
            req.pop("model")
            bodies.append(req)
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[0], bodies[2])

    def test_prompt_uses_only_displayed_intervention_fields_and_notes(self):
        unit = self.bundle["units"][1]
        unit["packet"]["trial"]["interventions"] = [{"intervention_type": "OTHER", "name": "Fictional intervention", "description": "HIDDEN_INTERVENTION_DESCRIPTION"}]
        unit["display"]["note"] = "Displayed study note"
        unit["display"]["parent_row_label"] = "Displayed parent group"
        raw = runner.encode(self.bundle)
        runner.validate_bundle(raw, runner.sha(raw))
        prompt = runner.request_for(self.bundle, unit, runner.MODELS[0])["messages"][0]["content"]
        self.assertNotIn("HIDDEN_INTERVENTION_DESCRIPTION", prompt)
        self.assertIn("Fictional intervention", prompt)
        self.assertIn("Displayed study note", prompt)
        self.assertIn("Displayed parent group", prompt)

    def test_provider_uses_current_api_key_auth_without_redirects_or_output(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        seen = []
        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, _):
                return b'{"id":"claude-sonnet-5"}'
        def open_fake(req, timeout):
            seen.append(req)
            return FakeResponse()
        with patch.object(provider.opener, "open", side_effect=open_fake):
            provider.call("/v1/models/claude-sonnet-5")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        self.assertEqual(seen[0].get_header("Anthropic-version"), "2026-10-21")
        with self.assertRaisesRegex(runner.Refused, "redirect_refused"):
            runner.NoRedirect().redirect_request(None, None, 302, None, None, "https://example.invalid/")

    def test_http_error_has_private_diagnostics_and_safe_public_exception(self):
        key = "SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY"
        provider = runner.Provider(key)
        body = runner.encode({"type": "error", "error": {"type": "invalid_request_error",
                              "message": "PRIVATE_EVIDENCE " + key}, "unexpected": "PRIVATE_EXTRA"})
        error = urllib.error.HTTPError("https://api.anthropic.com/v1/messages", 400,
                                       "PRIVATE_HTTP_REASON", {"request-id": "req_synthetic"}, io.BytesIO(body))
        output = io.StringIO()
        with patch.object(provider.opener, "open", side_effect=error), redirect_stdout(output), redirect_stderr(output):
            with self.assertRaises(runner.ProviderFailure) as caught:
                provider.message({})
        failure = caught.exception
        self.assertEqual(str(failure), "provider_http_400")
        self.assertEqual(failure.args, ("provider_http_400",))
        self.assertEqual(failure.diagnostic["http_status"], 400)
        self.assertEqual(failure.diagnostic["error_type"], "invalid_request_error")
        self.assertEqual(failure.diagnostic["request_id"], "req_synthetic")
        self.assertEqual(failure.diagnostic["message"], "PRIVATE_EVIDENCE [redacted]")
        self.assertNotIn(key, json.dumps(failure.diagnostic))
        self.assertNotIn("PRIVATE_EXTRA", json.dumps(failure.diagnostic))
        self.assertNotIn("PRIVATE", repr(failure))
        self.assertEqual(output.getvalue(), "")

    def test_http_failure_parsing_is_bounded_and_unknown_values_stay_private(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        cases = [(b"SECRET_NOT_JSON", 400), (b"x" * 70_000, 503),
                 (runner.encode({"error": {"type": "PRIVATE_TYPE", "message": "x" * 20_000}}), 429)]
        for body, status in cases:
            error = urllib.error.HTTPError("https://api.anthropic.com/v1/messages", status,
                                           "PRIVATE_REASON", {"request-id": "\nPRIVATE_HEADER"}, io.BytesIO(body))
            with self.subTest(status=status), patch.object(provider.opener, "open", side_effect=error):
                with self.assertRaises(runner.ProviderFailure) as caught:
                    provider.message({})
            failure = caught.exception
            self.assertEqual(str(failure), "provider_http_" + str(status))
            self.assertNotIn("request_id", failure.diagnostic)
            self.assertNotIn("PRIVATE", json.dumps(failure.diagnostic))
            if len(body) > 65_536:
                self.assertTrue(failure.diagnostic["body_truncated"])
                self.assertNotIn("message", failure.diagnostic)
            if "message" in failure.diagnostic:
                self.assertEqual(len(failure.diagnostic["message"]), 12_000)

    def test_request_id_survives_malformed_or_unreadable_http_error_body(self):
        class UnreadableBody(io.BytesIO):
            def read(self, _):
                raise OSError("PRIVATE_READ_ERROR")

        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        for label, body in (("html", io.BytesIO(b"<html>PRIVATE_UPSTREAM_ERROR</html>")),
                            ("unreadable", UnreadableBody())):
            error = urllib.error.HTTPError("https://api.anthropic.com/v1/messages", 502,
                                           "PRIVATE_HTTP_REASON", {"request-id": "req_synthetic"}, body)
            output = io.StringIO()
            with self.subTest(body=label), patch.object(provider.opener, "open", side_effect=error), \
                    redirect_stdout(output), redirect_stderr(output):
                with self.assertRaises(runner.ProviderFailure) as caught:
                    provider.message({})
                failure = caught.exception
                self.assertEqual(str(failure), "provider_http_502")
                self.assertEqual(failure.diagnostic.get("request_id"), "req_synthetic")
                self.assertTrue(failure.diagnostic["body_unreadable"])
                self.assertEqual(failure.diagnostic["http_status"], 502)
                self.assertNotIn("PRIVATE", repr(failure) + json.dumps(failure.diagnostic))
                self.assertEqual(output.getvalue(), "")

    def test_transport_errors_do_not_disclose_url_reason_or_retry(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        for error, category in [(TimeoutError("PRIVATE_TIMEOUT"), "provider_timeout"),
                                (urllib.error.URLError("https://PRIVATE_URL/"), "provider_connection_failed")]:
            with patch.object(provider.opener, "open", side_effect=error) as opened:
                with self.assertRaises(runner.ProviderFailure) as caught:
                    provider.message({})
            self.assertEqual(str(caught.exception), category)
            self.assertNotIn("PRIVATE", repr(caught.exception) + json.dumps(caught.exception.diagnostic))
            self.assertEqual(opened.call_count, 1)

    def test_http_failure_stops_run_with_diagnostics_and_reservation_retained(self):
        failure = runner.ProviderFailure("provider_http_400", {"http_status": 400, "message": "PRIVATE_ERROR_DETAIL"})
        provider = FakeProvider(lambda _: (_ for _ in ()).throw(failure))
        saved = []
        with self.assertRaisesRegex(runner.Refused, "^unreconciled_request$"):
            self.run_fake(provider, lambda state: saved.append(copy.deepcopy(state)))
        record = saved[-1]["records"][0]
        self.assertEqual(record["provider_diagnostic"]["message"], "PRIVATE_ERROR_DETAIL")
        self.assertEqual(record["status"], "unreconciled")
        self.assertGreater(record["reserved_micro_usd"], 0)
        self.assertNotIn("charged_micro_usd", record)
        self.assertEqual(len(provider.calls), 1)
        self.assertNotIn("PRIVATE_ERROR_DETAIL", json.dumps(runner.summary(self.state)))
        with self.assertRaisesRegex(runner.Refused, "^unreconciled_request$"):
            self.run_fake()

    def test_count_tokens_sends_same_prompt_schema_thinking_but_no_generation_fields(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        request = runner.request_for(self.bundle, self.bundle["units"][0], runner.MODELS[0])
        with patch.object(provider, "call", return_value={"input_tokens": 123}) as called:
            self.assertEqual(provider.count_tokens(request), 123)
        path, body = called.call_args.args
        self.assertEqual(path, "/v1/messages/count_tokens")
        self.assertEqual(body, {key: request[key] for key in ("model", "system", "messages", "thinking", "output_config")})
        for bad in (None, -1, True, "123"):
            with patch.object(provider, "call", return_value={"input_tokens": bad}), self.assertRaisesRegex(runner.Refused, "invalid_token_count"):
                provider.count_tokens(request)

    def test_preflight_counts_all_300_without_generation_or_ledger_changes(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        original = copy.deepcopy(self.state)
        reports = []
        output = io.StringIO()
        with patch.object(provider, "check_models"), patch.object(provider, "count_tokens", return_value=123) as count, \
                patch.object(provider, "message", side_effect=AssertionError("generation prohibited")), redirect_stdout(output):
            result = runner.preflight(self.bundle, self.digest, provider, lambda report: reports.append(copy.deepcopy(report)))
        self.assertEqual(count.call_count, 300)
        self.assertEqual(self.state, original)
        self.assertEqual(result["paid_requests"], 0)
        self.assertEqual(result["model_input_tokens"], {model: 12_300 for model in runner.MODELS})
        self.assertEqual(reports[0]["status"], "passed")
        self.assertEqual(len(reports[0]["records"]), 300)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("SYN-AI", json.dumps(result))
        self.assertNotIn(self.digest, json.dumps(result))

    def test_preflight_failure_saves_private_error_and_never_generates(self):
        provider = runner.Provider("SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY")
        failure = runner.ProviderFailure("provider_http_400", {"http_status": 400, "message": "PRIVATE_ERROR_DETAIL"})
        reports = []
        with patch.object(provider, "check_models"), patch.object(provider, "count_tokens", side_effect=failure) as count, \
                patch.object(provider, "message", side_effect=AssertionError("generation prohibited")):
            with self.assertRaisesRegex(runner.Refused, "^provider_http_400$"):
                runner.preflight(self.bundle, self.digest, provider, lambda report: reports.append(copy.deepcopy(report)))
        self.assertEqual(count.call_count, 1)
        self.assertEqual(reports[0]["status"], "failed")
        self.assertEqual(reports[0]["provider_diagnostic"]["message"], "PRIVATE_ERROR_DETAIL")

    def test_preflight_cli_never_reads_or_writes_paid_ledger(self):
        class FakeStore:
            def __init__(self, *args):
                pass
            def input_bytes(store):
                return self.raw
            def load(store):
                raise AssertionError("paid ledger read prohibited")
            def persist(store, _):
                raise AssertionError("paid ledger write prohibited")
            def persist_preflight(store, report):
                self.assertEqual(report["status"], "passed")
        with patch.object(runner, "PrivateStore", FakeStore), \
                patch.dict(runner.os.environ, {"AI_MAPPING_INPUT_SHA256": self.digest, "ANTHROPIC_API_KEY": "SYNTHETIC-CREDENTIAL-FOR-TEST-ONLY"}), \
                patch("sys.argv", ["runner.py", "preflight", "--private-store"]), \
                patch.object(runner.Provider, "check_models"), patch.object(runner.Provider, "count_tokens", return_value=123), \
                patch.object(runner.Provider, "message", side_effect=AssertionError("generation prohibited")), redirect_stdout(io.StringIO()) as output:
            runner.main()
        self.assertEqual(json.loads(output.getvalue())["status"], "preflight_passed")

    def test_preflight_cannot_receive_paid_opt_in(self):
        with patch("sys.argv", ["runner.py", "preflight", "--private-store", "--execute-paid"]), \
                patch.object(runner, "PrivateStore") as store, self.assertRaisesRegex(runner.Refused, "invalid_command"):
            runner.main()
        store.assert_not_called()

    def test_private_preflight_checkpoint_uses_distinct_path(self):
        with tempfile.TemporaryDirectory() as d:
            store = object.__new__(runner.PrivateStore)
            store.root = Path(d)
            (store.root / "state").mkdir()
            ledger = store.root / "state/mapping-review-ledger.json"
            ledger.write_bytes(b"ORIGINAL_LEDGER_UNCHANGED")
            with patch.object(store, "git", return_value=b"") as git:
                store.persist_preflight({"status": "failed"})
            self.assertEqual(ledger.read_bytes(), b"ORIGINAL_LEDGER_UNCHANGED")
            self.assertEqual((store.root / "state/mapping-review-preflight.json").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("mapping-review-ledger.json", repr(git.call_args_list))
            with self.assertRaisesRegex(runner.Refused, "unsafe_output"):
                store.persist_document("../unsafe.json", {})

    def test_budget_rejects_nonfinite_overcap_and_reserves_before_call(self):
        for amount in ("100", "95.01", "NaN", "Infinity", "0", "-1", "0.0000001"):
            with self.subTest(amount=amount), self.assertRaises(runner.Refused):
                runner.cap_micro(amount)
        self.cap = 1
        self.state = runner.new_state(self.digest, self.cap, "SYNTHETIC-APPROVAL")
        provider = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "budget_exhausted"):
            self.run_fake(provider)
        self.assertEqual(provider.calls, [])

    def test_all_three_arms_300_requests_and_durable_reservations(self):
        checkpoints = []
        provider = FakeProvider()
        def persist(state):
            # Each call is preceded by its checkpoint; no private output reaches stdout.
            checkpoints.append(copy.deepcopy(state))
            if state["records"][-1]["status"] == "reserved":
                self.assertEqual(len(provider.calls), len(state["records"]) - 1)
        result = self.run_fake(provider, persist)
        self.assertEqual(result["completed_requests"], 300)
        self.assertEqual(len(checkpoints), 600)
        self.assertEqual(set(r["model"] for r in self.state["records"]), set(runner.MODELS))
        self.assertNotIn("AGREE", json.dumps(result))
        self.assertNotIn("SYN-AI", json.dumps(result))

    def test_failed_checkpoint_prevents_paid_call(self):
        provider = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "private_store_sync_failed"):
            self.run_fake(provider, lambda _: (_ for _ in ()).throw(runner.Refused("private_store_sync_failed")))
        self.assertEqual(provider.calls, [])

    def test_transport_failure_cannot_be_retried_on_resume(self):
        provider = FakeProvider(lambda _: (_ for _ in ()).throw(TimeoutError("sensitive raw provider message")))
        saved = []
        with self.assertRaisesRegex(runner.Refused, "unreconciled_request"):
            self.run_fake(provider, lambda state: saved.append(copy.deepcopy(state)))
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(saved[-1]["records"][0]["status"], "unreconciled")
        self.assertNotIn("sensitive raw", json.dumps(saved))
        again = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "unreconciled_request"):
            self.run_fake(again)
        self.assertEqual(again.calls, [])
        self.assertEqual(again.checked, 0)

    def test_combined_budget_applies_across_models(self):
        third_reservation = runner.reserve_cost(runner.request_for(self.bundle, self.bundle["units"][0], runner.MODELS[2]))
        self.cap = 1000 + third_reservation - 1  # first two fake responses cost 500 microUSD each
        self.state = runner.new_state(self.digest, self.cap, "SYNTHETIC-APPROVAL")
        provider = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "budget_exhausted"):
            self.run_fake(provider)
        self.assertEqual([c["model"] for c in provider.calls], list(runner.MODELS[:2]))

    def test_checkpoint_after_call_failure_leaves_durable_reservation(self):
        saved = []
        def persist(state):
            if state["records"][-1]["status"] == "complete":
                raise runner.Refused("private_store_sync_failed")
            saved.append(copy.deepcopy(state))
        provider = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "private_store_sync_failed"):
            self.run_fake(provider, persist)
        self.assertEqual(len(provider.calls), 1)
        self.state = saved[-1]
        again = FakeProvider()
        with self.assertRaisesRegex(runner.Refused, "unreconciled_request"):
            self.run_fake(again)
        self.assertEqual(again.calls, [])

    def test_private_store_refuses_public_repository_before_cloning(self):
        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, _):
                return b'{"private":false,"full_name":"synthetic-owner/synthetic-store","default_branch":"main"}'
        class FakeOpener:
            def open(self, *_args, **_kwargs):
                return FakeResponse()
        with tempfile.TemporaryDirectory() as d, patch.object(runner.urllib.request, "build_opener", return_value=FakeOpener()), patch.object(runner.subprocess, "run") as git:
            with self.assertRaisesRegex(runner.Refused, "private_store_required"):
                runner.PrivateStore(Path(d), "synthetic-owner/synthetic-store", "SYNTHETIC-TOKEN", "a" * 40)
            git.assert_not_called()

    def test_model_mismatch_truncation_bad_schema_block(self):
        unit = self.bundle["units"][1]
        req = runner.request_for(self.bundle, unit, runner.MODELS[0])
        for patch_value in ({"model": "different-model"}, {"stop_reason": "max_tokens"}, {"content": [{"type": "text", "text": "not JSON"}]}):
            bad = {**response(req), **patch_value}
            with self.assertRaises(runner.Refused):
                runner.validate_response(bad, runner.MODELS[0], unit)

    def test_response_requires_reason_note_and_separate_subtype(self):
        unit = self.bundle["units"][0]
        req = runner.request_for(self.bundle, unit, runner.MODELS[0])
        for r in (response(req), response(req, answer="DISAGREE", subtype="TYPE_2_STATED"),
                  response(req, answer="CANNOT_TELL", subtype="TYPE_2_STATED"),
                  response(req, reason="OTHER_SPECIFIED", subtype="TYPE_2_STATED"),
                  response(req, note="x" * 2001, subtype="TYPE_2_STATED")):
            with self.assertRaises(runner.Refused):
                runner.validate_response(r, runner.MODELS[0], unit)
        good = response(req, answer="DISAGREE", reason="OTHER_SPECIFIED", note="Fictional justification.", subtype="TYPE_2_STATED")
        self.assertEqual(runner.validate_response(good, runner.MODELS[0], unit)["diabetes_subtype"], "TYPE_2_STATED")

    def test_resume_skips_success_and_revalidates_ledger(self):
        self.run_fake()
        provider = FakeProvider()
        self.run_fake(provider)
        self.assertEqual(provider.calls, [])
        self.state["records"][0]["charged_micro_usd"] = 0
        with self.assertRaisesRegex(runner.Refused, "invalid_ledger"):
            self.run_fake(FakeProvider())

    def test_resume_refuses_different_input_cap_or_approval(self):
        for args in (("f" * 64, self.cap, "SYNTHETIC-APPROVAL"), (self.digest, self.cap - 1, "SYNTHETIC-APPROVAL"), (self.digest, self.cap, "OTHER")):
            with self.assertRaises(runner.Refused):
                runner.validate_state(self.state, *args)

    def test_atomic_local_checkpoint_is_private(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "state.json"
            runner.atomic_private(path, self.state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["format"], runner.STATE_FORMAT)

    def test_workflow_is_manual_only_and_never_uploads_results(self):
        workflow = Path(__file__).parents[2] / ".github/workflows/ai-mapping-review.yml"
        source = workflow.read_text()
        self.assertIn("workflow_dispatch:", source)
        self.assertNotIn("pull_request:", source)
        self.assertNotIn("push:", source)
        self.assertNotIn("schedule:", source)
        self.assertNotIn("upload-artifact", source)
        self.assertIn("cancel-in-progress: false", source)
        self.assertIn("persist-credentials: false", source)
        self.assertIn("--execute-paid", source)


if __name__ == "__main__":
    unittest.main()
