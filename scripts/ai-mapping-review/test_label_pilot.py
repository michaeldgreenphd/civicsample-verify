"""Entirely fictional packets and mocked services. No network, credentials or study records."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import runner as R
import label_pilot as P
import prepare_label_pilot as B
from test_runner import fixture as old_fixture, FakeProvider as OldProvider


def fixture():
    old = old_fixture()
    for i, u in enumerate(old['units']):
        u['packet']['unit'].update(family='AREA', category='CARDIOVASCULAR', unit_role='PRIMARY', assignment_code='IN_AREA')
        u['packet']['trial']['nct_id'] = f'SYNTHETIC-TRIAL-{i}'
        u['packet']['trial']['brief_summary'] = 'Fictional evidence about cardiovascular care, not a real study.'
        u['subtype_required'] = False
    raw = R.encode(old)
    baseline = R.new_state(R.sha(raw), 95_000_000, 'SYNTHETIC-ORIGINAL-APPROVAL')
    R.run(old, R.sha(raw), baseline, 95_000_000, 'SYNTHETIC-ORIGINAL-APPROVAL', OldProvider(), lambda _: None)
    baseline_raw = R.encode(baseline)
    b = {'format': P.FORMAT, 'comparison_input': raw.decode(),
         'baseline': {'input_sha256': R.sha(raw), 'ledger_sha256': R.sha(baseline_raw)},
         'source_sha256': {k: 'a' * 64 for k in P.SOURCES},
         'memberships': [{'unit_id': u['unit_id'], 'original_labels': ['AREA_CARDIOVASCULAR']} for u in old['units']]}
    return b, baseline_raw


def response(request, change=False, uncertain=False, category='AREA_IMMUNE'):
    evidence = json.loads(request['messages'][0]['content'])
    values = []
    for code in P.IDS:
        values.append({'id': code, 'decision': 'SUPPORTED' if code in evidence['original_labels'] else 'NOT_SUPPORTED',
                       'uncertain': False, 'reason': 'Fictional explanation.', 'evidence': []})
    if change or uncertain:
        a = next(v for v in values if v['id'] == category)
        a.update(decision='SUPPORTED', uncertain=uncertain,
                 evidence=[{'field': 'brief_summary', 'quote': evidence['evidence_fields']['brief_summary']}])
    return {'id': 'synthetic-response', 'model': request['model'], 'stop_reason': 'end_turn',
            'content': [{'type': 'text', 'text': json.dumps({'assessments': values})}],
            'usage': {'input_tokens': 200, 'output_tokens': 300}}


class Provider:
    def __init__(self, mutate=None):
        self.requests = []
        self.counts = []
        self.mutate = mutate
    def call(self, path):
        return {'id': path.removeprefix('/v1/models/')}
    def message(self, request):
        self.requests.append(copy.deepcopy(request))
        r = response(request)
        return self.mutate(request, r) if self.mutate else r
    def count_tokens(self, request):
        self.counts.append(copy.deepcopy(request))
        return 200


class LabelPilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture, cls.baseline_raw = fixture()

    def setUp(self):
        self.b = copy.deepcopy(self.fixture)
        self.digest = R.sha(R.encode(self.b))
        self.baseline_cost = P.verify_baseline(self.b, self.baseline_raw)
        self.state = P.new_state(self.digest, self.baseline_cost, P.PILOT_MAX, 'SYNTHETIC-PILOT-APPROVAL')
        self.unit = P.units(self.b)[0]

    def run_fake(self, provider=None, persist=lambda _: None, cap=P.PILOT_MAX):
        return P.run(self.b, self.digest, self.state, self.baseline_cost, cap,
                     'SYNTHETIC-PILOT-APPROVAL', provider or Provider(), persist)

    def changed_answer(self, edit):
        req = P.request_for(self.b, self.unit, P.SCREEN)
        r = response(req)
        a = json.loads(r['content'][0]['text'])
        edit(a['assessments'])
        r['content'][0]['text'] = json.dumps(a)
        return r

    def test_bundle_has_exactly_original_100_trials_and_no_new_guide(self):
        self.assertEqual(P.validate_bundle(R.encode(self.b), self.digest), self.b)
        for edit in (
            lambda b: b['memberships'].pop(),
            lambda b: b['memberships'][0]['original_labels'].append('NEW_LABEL'),
            lambda b: b['memberships'][0].update(original_labels=[]),
            lambda b: b['memberships'][0].update(unit_id='UNASSIGNED'),
        ):
            b = copy.deepcopy(self.b); edit(b)
            with self.assertRaises(R.Refused):
                P.validate_bundle(R.encode(b), R.sha(R.encode(b)))
        b = copy.deepcopy(self.b)
        b['comparison_input'] = b['comparison_input'].replace('Fictional guide', 'Altered guide')
        with self.assertRaisesRegex(R.Refused, 'input_digest_mismatch'):
            P.validate_bundle(R.encode(b), R.sha(R.encode(b)))

    def test_repeated_trials_refused(self):
        old = P.original(self.b)
        old['units'][1]['packet']['trial']['nct_id'] = old['units'][0]['packet']['trial']['nct_id']
        raw = R.encode(old)
        self.b['comparison_input'], self.b['baseline']['input_sha256'] = raw.decode(), R.sha(raw)
        with self.assertRaisesRegex(R.Refused, 'duplicate_trial'):
            P.validate_bundle(R.encode(self.b), R.sha(R.encode(self.b)))

    def test_baseline_is_complete_unchanged_and_held_charge_is_counted(self):
        before = self.baseline_raw
        self.assertGreater(P.verify_baseline(self.b, before), 0)
        self.assertEqual(before, self.baseline_raw)
        for key in ('answer', 'request_sha256', 'charged_micro_usd'):
            baseline = R.decode(before)
            baseline['records'][0][key] = None
            raw = R.encode(baseline)
            self.b['baseline']['ledger_sha256'] = R.sha(raw)
            with self.assertRaises(R.Refused):
                P.verify_baseline(self.b, raw)
        baseline = R.decode(before); baseline['records'].pop()
        raw = R.encode(baseline); self.b['baseline']['ledger_sha256'] = R.sha(raw)
        with self.assertRaisesRegex(R.Refused, 'baseline_incomplete'):
            P.verify_baseline(self.b, raw)
        # The actual reservation carry-over is checked by the original runner and
        # passed intact to this ledger. This value must not disappear on resume.
        state = P.new_state(self.digest, 7_280_398, P.PILOT_MAX, 'APPROVAL')
        self.assertEqual(P.summary(self.b, self.digest, state)['combined_accounted_usd'], 7.280398)

    def test_catalog_is_10_areas_and_10_rows_not_subgroup_retest(self):
        self.assertEqual(sum(c['family'] == 'AREA' for c in P.CATALOG), 10)
        self.assertEqual(sum(c['family'] == 'ROW' for c in P.CATALOG), 10)
        self.assertEqual(len(set(P.IDS)), 20)

    def test_opus_prompt_independent_and_no_other_answers_or_sampling_metadata(self):
        a = P.request_for(self.b, self.unit, P.SCREEN)
        o = P.request_for(self.b, self.unit, P.AUDIT)
        self.assertEqual({k:v for k,v in a.items() if k != 'model'}, {k:v for k,v in o.items() if k != 'model'})
        serialized = R.encode(a).decode()
        for secret in ('SYNTHETIC-ORIGINAL-APPROVAL', 'SYN-AI-001', 'selection_probability', 'baseline', 'sample_sha256'):
            self.assertNotIn(secret, serialized)
        self.assertIn('several areas and rows at once', serialized)
        self.unit['trial']['interventions'] = [{'name': 'fictional', 'intervention_type': 'OTHER', 'description': 'NOT-DISPLAYED-SECRET'}]
        self.assertNotIn('NOT-DISPLAYED-SECRET', R.encode(P.request_for(self.b, self.unit, P.SCREEN)).decode())

    def test_actions_keep_polarity_and_uncertainty_separate(self):
        for code, decision, uncertain, expected in [
            ('AREA_CARDIOVASCULAR', 'SUPPORTED', False, 'KEEP'),
            ('AREA_CARDIOVASCULAR', 'NOT_SUPPORTED', False, 'PROPOSE_REMOVE'),
            ('AREA_IMMUNE', 'SUPPORTED', False, 'PROPOSE_ADD'),
            ('AREA_IMMUNE', 'NOT_SUPPORTED', False, 'NO_CHANGE'),
            ('AREA_IMMUNE', 'INSUFFICIENT_INFORMATION', False, 'REVIEW'),
            ('AREA_CARDIOVASCULAR', 'SUPPORTED', True, 'REVIEW')]:
            self.assertEqual(P.action({'id': code, 'decision': decision, 'uncertain': uncertain}, self.unit), expected)

    def test_all20_exactly_once_known_labels_and_complete_generation_required(self):
        for edit in (lambda a:a.pop(), lambda a:a.append(a[0]), lambda a:a[0].update(id=a[1]['id']),
                     lambda a:a[0].update(id='UNKNOWN'), lambda a:a[0].update(uncertain='false'),
                     lambda a:a[0].update(reason='')):
            with self.assertRaises(R.Refused):
                P.validate_response(self.changed_answer(edit), P.SCREEN, self.unit)
        for field, value in [('model', P.AUDIT), ('stop_reason', 'max_tokens'), ('stop_details', {'refusal':'yes'})]:
            r = self.changed_answer(lambda _:None); r[field] = value
            with self.assertRaises(R.Refused):
                P.validate_response(r, P.SCREEN, self.unit)

    def test_addition_and_removal_need_literal_source_evidence(self):
        for idx, decision in [(0, 'SUPPORTED'), (1, 'NOT_SUPPORTED')]:
            with self.assertRaisesRegex(R.Refused, 'missing_change_evidence'):
                P.validate_response(self.changed_answer(lambda a:a[idx].update(decision=decision)), P.SCREEN, self.unit)
        request = P.request_for(self.b, self.unit, P.SCREEN)
        good = response(request, change=True)
        self.assertEqual(len(P.validate_response(good, P.SCREEN, self.unit)['assessments']), 20)
        for field, quote in [('brief_summary', 'Invented quote not found in evidence'), ('condition_mesh_headings.0', 'Fictional evidence'),
                             ('brief_summary', 'Fic'), ('not-a-field', 'Fictional evidence')]:
            a = json.loads(good['content'][0]['text'])
            next(v for v in a['assessments'] if v['id'] == 'AREA_IMMUNE')['evidence'] = [{'field':field, 'quote':quote}]
            r = copy.deepcopy(good); r['content'][0]['text'] = json.dumps(a)
            with self.assertRaises(R.Refused): P.validate_response(r, P.SCREEN, self.unit)

    def test_deterministic_controls_and_no_changes_still_get_20_audits(self):
        expected = P.audit_controls(self.b, self.digest)
        self.assertEqual(len(set(expected)), 20)
        self.assertEqual(expected, P.audit_controls(self.b, self.digest))
        provider = Provider(); result = self.run_fake(provider)
        self.assertEqual((result['status'],result['screened_trials'],result['audited_trials']), ('complete',100,20))
        self.assertEqual(len(provider.requests), 120)
        self.assertEqual({r['unit_id'] for r in self.state['records'] if r['model'] == P.AUDIT}, set(expected))

    def test_proposed_changes_uncertainty_and_cannot_tell_all_get_independent_audit(self):
        for disposition in ('change', 'uncertain', 'cannot_tell'):
            with self.subTest(disposition=disposition):
                self.state = P.new_state(self.digest, self.baseline_cost, P.PILOT_MAX, 'SYNTHETIC-PILOT-APPROVAL')
                def mutate(req, result):
                    if req['model'] == P.SCREEN:
                        if disposition == 'cannot_tell':
                            a=json.loads(result['content'][0]['text']); a['assessments'][0]['decision']='INSUFFICIENT_INFORMATION'
                            result['content'][0]['text']=json.dumps(a)
                            return result
                        return response(req, change=disposition == 'change', uncertain=disposition == 'uncertain')
                    return result
                provider=Provider(mutate); result=self.run_fake(provider)
                self.assertEqual(result['audited_trials'],100)
                # Opus receives only the same source packet, never the screening rationale.
                self.assertEqual(provider.requests[0]['messages'], next(r for r in provider.requests[100:] if r['messages']==provider.requests[0]['messages'])['messages'])

    def test_resume_never_repeats_paid_calls_or_accepts_modified_answers(self):
        self.run_fake()
        provider=Provider(); result=self.run_fake(provider)
        self.assertEqual(provider.requests,[]); self.assertEqual(result['status'],'complete')
        for field,value in [('request_sha256','f'*64),('reserved_micro_usd',1),('charged_micro_usd',0),('answer',{})]:
            state=copy.deepcopy(self.state); state['records'][0][field]=value
            with self.assertRaises(R.Refused):
                P.validate_state(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT-APPROVAL')

    def test_pilot_and_combined_ceiling_both_enforced_before_call(self):
        for prior,cap in [(self.baseline_cost,1),(94_999_999,P.PILOT_MAX)]:
            state=P.new_state(self.digest,prior,cap,'APPROVAL'); provider=Provider()
            with self.assertRaisesRegex(R.Refused,'budget_exhausted'):
                P.run(self.b,self.digest,state,prior,cap,'APPROVAL',provider,lambda _:None)
            self.assertEqual(provider.requests,[])
        for cap in (20_000_001,0,-1,True):
            with self.assertRaises(R.Refused): P.new_state(self.digest,self.baseline_cost,cap,'APPROVAL')

    def test_durable_reservation_precedes_call_and_failure_is_not_retryable(self):
        saved=[]
        def mutate(req, _):
            self.assertEqual(saved[-1]['records'][-1]['status'],'reserved')
            raise R.ProviderFailure('provider_http_400',{'message':'PRIVATE ERROR TEXT'})
        provider=Provider(mutate)
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            self.run_fake(provider, lambda s:saved.append(copy.deepcopy(s)))
        self.assertEqual(len(provider.requests),1)
        self.assertEqual(self.state['records'][0]['status'],'unreconciled')
        self.assertGreater(P.pilot_cost(self.state),0)
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'): self.run_fake(provider)
        self.assertEqual(len(provider.requests),1)
        fresh=P.new_state(self.digest,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT-APPROVAL')
        def fail(_): raise R.Refused('private_store_sync_failed')
        provider=Provider()
        with self.assertRaises(R.Refused):
            P.run(self.b,self.digest,fresh,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT-APPROVAL',provider,fail)
        self.assertEqual(provider.requests,[])

    def test_provider_output_over_reserved_ceiling_is_retained_and_stops(self):
        def mutate(_,r): r['usage']['output_tokens']=999999; return r
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'): self.run_fake(Provider(mutate))
        self.assertEqual(self.state['records'][0]['failure_category'],'reservation_exceeded')

    def test_preflight_is_free_bound_and_required_for_all_possible_audits(self):
        saved=[]; provider=Provider()
        result=P.preflight(self.b,self.digest,provider,saved.append)
        self.assertEqual(result['paid_requests'],0); self.assertEqual(provider.requests,[])
        self.assertEqual(len(provider.counts),200)
        P.validate_preflight(self.b,self.digest,saved[0])
        for edit in (lambda r:r['records'].pop(), lambda r:r.update(status='failed'),
                     lambda r:r['records'][0].update(request_sha256='0'*64),
                     lambda r:r['records'][0].update(input_tokens=True)):
            report=copy.deepcopy(saved[0]); edit(report)
            with self.assertRaisesRegex(R.Refused,'preflight_required'): P.validate_preflight(self.b,self.digest,report)

    def test_private_store_cannot_overwrite_old_ledger_or_other_paths(self):
        store=object.__new__(P.PilotStore)
        for name in ('mapping-review-ledger.json','mapping-review-preflight.json','../inputs/mapping-review.json'):
            with self.assertRaisesRegex(R.Refused,'unsafe_output'): store.persist_document(name,{})
        with tempfile.TemporaryDirectory() as d:
            store.root=Path(d); (store.root/'state').mkdir()
            store.source_commit='a'*40
            path=store.root/'state/mapping-review-ledger.json'; path.write_bytes(b'ORIGINAL')
            store.read_blob=lambda _:b'ORIGINAL'
            self.assertEqual(store.baseline_bytes(),b'ORIGINAL')
            path.write_bytes(b'MODIFIED')
            with self.assertRaisesRegex(R.Refused,'baseline_changed'): store.baseline_bytes()

    def test_public_summaries_never_contain_cases_answers_or_provider_text(self):
        self.run_fake()
        output=json.dumps(P.summary(self.b,self.digest,self.state))+json.dumps(P.dry_run(self.b))
        for private in ('SYN-AI','Fictional','brief_summary','SUPPORTED','original_labels','PRIVATE ERROR'):
            self.assertNotIn(private,output)

    def test_cli_rejects_paid_without_auth_without_touching_network(self):
        for args in (['run'],['run','--input','/tmp/private','--execute-paid'],['preflight','--execute-paid']):
            with patch('sys.argv',['label_pilot.py',*args]), patch.object(P,'PilotStore') as store, patch.object(R,'Provider') as provider:
                with self.assertRaises(R.Refused): P.main()
                provider.assert_not_called(); store.assert_not_called()

    def test_workflow_is_manual_main_approved_and_serialized_with_original(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/'.github/workflows/ai-label-pilot.yml').read_text()
        for required in ('workflow_dispatch:', 'environment: ai-mapping-review','group: private-ai-mapping-review',
                         'cancel-in-progress: false','github.event.repository.default_branch','persist-credentials: false'):
            self.assertIn(required,workflow)
        self.assertNotIn('pull_request:',workflow); self.assertNotIn('upload-artifact',workflow)
        self.assertNotIn('AI_MAPPING_INPUT_SHA256:',workflow)


class BuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.b,cls.baseline=fixture()
    def sources(self):
        ids=[u['packet']['trial']['nct_id'] for u in P.original(self.b)['units']]
        cols=['nct_id',*['v54_is_'+v for v in B.AREA_COLUMNS.values()]]
        area=','.join(cols)+'\n'+''.join(','.join([uid,*['TRUE' if col=='v54_is_cardio' else 'FALSE' for col in cols[1:]]])+'\n' for uid in ids)
        return { 'area_flags':area.encode(), 'condition_map':('nct_id,condition_category\n'+''.join(uid+',Fictional other category\n' for uid in ids)).encode(),
                 'diabetes_rules':b'nct_id,rule_status\n','neoplasm_rules':b'nct_id,rule_status\n','condition_frame':b'nct_id,row_id\n'}
    def build(self,s):
        return B.prepare(self.b['comparison_input'].encode(),self.b['baseline']['input_sha256'],self.baseline,
                         self.b['baseline']['ledger_sha256'],s)
    def test_source_join_retains_original_bytes_and_records_hashes(self):
        source=self.sources(); result=self.build(source)
        self.assertEqual(result['comparison_input'],self.b['comparison_input'])
        self.assertEqual(result['memberships'],self.b['memberships'])
        self.assertEqual(result['source_sha256'],{k:R.sha(v) for k,v in source.items()})
    def test_missing_or_duplicate_trial_and_nonboolean_flags_refused(self):
        for edit in (lambda s:s.update(area_flags=s['area_flags'].replace(b'TRUE',b'',1)),
                     lambda s:s.update(area_flags=s['area_flags']+s['area_flags'].splitlines(keepends=True)[1]),
                     lambda s:s.update(condition_map=b'nct_id,condition_category\n')):
            s=self.sources(); edit(s)
            with self.assertRaises(R.Refused): self.build(s)
    def test_exclusion_status_not_missing_frame_decides_original_membership(self):
        uid=P.original(self.b)['units'][0]['packet']['trial']['nct_id']
        s=self.sources(); s['condition_map']+=(uid+',Diabetes Mellitus\n').encode()
        s['diabetes_rules']+=(uid+',REMOVE\n').encode()
        result=self.build(s)
        self.assertNotIn('ROW_DIAB',result['memberships'][0]['original_labels'])
        s['diabetes_rules']=s['diabetes_rules'].replace(b'REMOVE',b'KEEP')
        with self.assertRaisesRegex(R.Refused,'condition_frame_mismatch'):self.build(s)
        s['condition_frame']+=(uid+',DIAB\n').encode()
        self.assertIn('ROW_DIAB',self.build(s)['memberships'][0]['original_labels'])
    def test_rule_trial_absence_not_silently_interpreted_as_keep(self):
        uid=P.original(self.b)['units'][0]['packet']['trial']['nct_id']
        s=self.sources(); s['condition_map']+=(uid+',Diabetes Mellitus\n').encode()
        with self.assertRaisesRegex(R.Refused,'missing_rule_trial'):self.build(s)
    def test_builder_refuses_overwrite_and_checkout_output(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); (p/'.git').mkdir(); (p/'nested').mkdir()
            with self.assertRaisesRegex(R.Refused,'unsafe_path'):B.private_path(str(p/'nested/out.json'),exists=False)
            (p/'.git').rmdir(); (p/'exists.json').write_text('preserve')
            with self.assertRaisesRegex(R.Refused,'unsafe_path'):B.private_path(str(p/'exists.json'),exists=False)
            self.assertEqual((p/'exists.json').read_text(),'preserve')


if __name__=='__main__': unittest.main()
