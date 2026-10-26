"""Fictional response failures, verified charges, and bounded manual retry preparation."""
import copy
import io
import json
import os
from contextlib import redirect_stdout
import unittest
from unittest.mock import patch

import label_pilot as P
import runner as R
import test_label_recovery as prior_recovery
from test_label_pilot import fixture, response, Provider


def incomplete(request):
    value = response(request)
    answer = json.loads(value['content'][0]['text'])
    answer['assessments'] = answer['assessments'][:1]
    answer['assessments'][0]['reason'] = ''
    value['content'][0]['text'] = json.dumps(answer)
    return value


def failed_receipt(bundle, unit):
    request = P.request_for(bundle, unit, P.SCREEN)
    value = incomplete(request)
    cost, usage = R.usage_cost(value, P.SCREEN)
    return {'model': P.SCREEN, 'unit_id': unit['unit_id'], 'status': 'unreconciled',
        'request_sha256': R.sha(R.encode(request)), 'reserved_micro_usd': P.reservation(request),
        'reserved_at': R.now(), 'response': value, 'charged_micro_usd': cost,
        'usage': usage, 'failure_category': 'invalid_answer'}


class LabelRetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle, cls.baseline = fixture()

    def setUp(self):
        self.b = copy.deepcopy(self.bundle)
        self.digest = R.sha(R.encode(self.b))
        self.baseline_cost = P.verify_baseline(self.b, self.baseline)
        self.state = P.new_state(self.digest, self.baseline_cost, P.PILOT_MAX, 'SYNTHETIC-RETRY')
        self.state['records'].append(failed_receipt(self.b, P.units(self.b)[0]))

    def prepare(self, state=None, cap=P.PILOT_MAX):
        return P.prepare_retry(self.b, self.digest, self.state if state is None else state,
            self.baseline_cost, cap, 'SYNTHETIC-RETRY', 'b' * 40)

    def test_partial_answer_is_rejected_archived_unchanged_and_still_charged(self):
        before = R.encode(self.state)
        result = self.prepare()
        self.assertEqual(R.encode(self.state), before)
        self.assertEqual(result['format'], P.RETRIED_LEDGER_FORMAT)
        self.assertEqual(result['records'], [])
        self.assertEqual(result['rejected_attempts'][0]['record'], self.state['records'][0])
        self.assertEqual(result['rejected_attempts'][0]['previous_ledger_sha256'], R.sha(before))
        self.assertEqual(P.pilot_cost(result), P.pilot_cost(self.state))
        with self.assertRaisesRegex(R.Refused, 'invalid_answer'):
            P.validate_response(self.state['records'][0]['response'], P.SCREEN, P.units(self.b)[0])
        P.validate_state(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY')

    def test_resume_retries_only_missing_request_and_keeps_both_charges(self):
        result = self.prepare()
        provider = Provider()
        summary = P.run(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',provider,lambda _:None)
        self.assertEqual(summary['status'], 'complete')
        self.assertEqual(summary['rejected_attempts'], 1)
        self.assertEqual(len(result['records']),120)
        self.assertEqual(len(provider.requests),120)
        self.assertEqual(P.pilot_cost(result), sum(r['charged_micro_usd'] for r in result['records'])
                         + self.state['records'][0]['charged_micro_usd'])
        self.assertEqual(result['rejected_attempts'][0]['record'], self.state['records'][0])
        P.validate_state(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY')

    def test_second_failure_on_the_same_request_cannot_be_retried_again(self):
        result = self.prepare()
        provider = Provider(lambda request, _: incomplete(request))
        with self.assertRaisesRegex(R.Refused, 'unreconciled_request'):
            P.run(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',provider,lambda _:None)
        self.assertEqual(len(provider.requests), 1)
        self.assertEqual(len(result['records']),1)
        self.assertEqual(result['records'][0]['status'],'unreconciled')
        self.assertEqual(P.pilot_cost(result), 2*self.state['records'][0]['charged_micro_usd'])
        with self.assertRaisesRegex(R.Refused,'retry_limit_reached'): self.prepare(result)

    def test_different_failed_request_can_be_prepared_without_rewriting_earlier_history(self):
        result = self.prepare()
        first_archive = copy.deepcopy(result['rejected_attempts'])
        count = 0
        def mutate(request, good):
            nonlocal count
            count += 1
            return incomplete(request) if count == 2 else good
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            P.run(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',Provider(mutate),lambda _:None)
        first_complete = copy.deepcopy(result['records'][0])
        second = self.prepare(result)
        self.assertEqual(second['rejected_attempts'][:1], first_archive)
        self.assertEqual(second['records'], [first_complete])
        tampered = copy.deepcopy(second)
        tampered['records'][0]['completed_at'] = 'changed'
        with self.assertRaisesRegex(R.Refused,'invalid_retry'):
            P.validate_state(self.b,self.digest,tampered,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY')
        summary = P.run(self.b,self.digest,second,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',Provider(),lambda _:None)
        self.assertEqual(summary['status'],'complete')
        self.assertEqual(summary['rejected_attempts'],2)
        P.validate_state(self.b,self.digest,second,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY')

    def test_rejected_charge_still_reduces_remaining_budget_before_any_paid_request(self):
        record = self.state['records'][0]
        cap = record['reserved_micro_usd'] + record['charged_micro_usd'] - 1
        self.state['pilot_cap_micro_usd'] = cap
        result = self.prepare(cap=cap)
        provider = Provider()
        with self.assertRaisesRegex(R.Refused,'budget_exhausted'):
            P.run(self.b,self.digest,result,self.baseline_cost,cap,'SYNTHETIC-RETRY',provider,lambda _:None)
        self.assertEqual(provider.requests,[])

    def test_rejected_charge_also_counts_against_overall_ceiling(self):
        record = self.state['records'][0]
        baseline = R.MAX_CAP_MICRO_USD - record['reserved_micro_usd'] - record['charged_micro_usd'] + 1
        self.state['baseline_accounted_micro_usd'] = baseline
        result = P.prepare_retry(self.b,self.digest,self.state,baseline,P.PILOT_MAX,'SYNTHETIC-RETRY','b'*40)
        provider = Provider()
        with self.assertRaisesRegex(R.Refused,'budget_exhausted'):
            P.run(self.b,self.digest,result,baseline,P.PILOT_MAX,'SYNTHETIC-RETRY',provider,lambda _:None)
        self.assertEqual(provider.requests,[])

    def test_unverified_billing_unknown_outcome_and_changed_request_refused(self):
        for key, value in [('charged_micro_usd',0),('usage',{}),('reserved_micro_usd',1),
            ('request_sha256','0'*64),('failure_category','request_failed'),('status','reserved')]:
            state = copy.deepcopy(self.state); state['records'][0][key] = value
            with self.assertRaises(R.Refused): self.prepare(state)
        for key in ('charged_micro_usd','response','usage'):
            state = copy.deepcopy(self.state); del state['records'][0][key]
            with self.assertRaises(R.Refused): self.prepare(state)
        state = copy.deepcopy(self.state); state['records'][0]['response']['model'] = P.AUDIT
        with self.assertRaisesRegex(R.Refused,'model_mismatch'): self.prepare(state)

    def test_valid_answer_mislabelled_as_failed_cannot_be_replaced(self):
        state = copy.deepcopy(self.state)
        state['records'][0]['response'] = response(P.request_for(self.b,P.units(self.b)[0],P.SCREEN))
        with self.assertRaisesRegex(R.Refused,'invalid_retry'): self.prepare(state)

    def test_archive_and_completed_prefix_tampering_refused(self):
        result = self.prepare()
        P.run(self.b,self.digest,result,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',Provider(),lambda _:None)
        for change in ('hash','prefix','charge','response','source','format','missing_archive','duplicate'):
            state = copy.deepcopy(result); entry = state['rejected_attempts'][0]
            if change == 'hash': entry['previous_ledger_sha256'] = '0'*64
            elif change == 'prefix': entry['completed_prefix_length'] = 1
            elif change == 'charge': entry['record']['charged_micro_usd'] = 0
            elif change == 'response': entry['record']['response']['content'][0]['text'] = '{}'
            elif change == 'source': entry['source_commit'] = 'not-a-commit'
            elif change == 'format': state['format'] = P.LEDGER_FORMAT
            elif change == 'missing_archive': del state['rejected_attempts']
            else: state['rejected_attempts'].append(copy.deepcopy(entry))
            with self.assertRaises(R.Refused):
                P.validate_state(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY')

    def test_prior_short_condition_recovery_stays_valid_and_identical(self):
        prior_recovery.ShortConditionRecoveryTests.setUpClass()
        context = prior_recovery.ShortConditionRecoveryTests()
        context.setUp()
        state = context.recover()
        old_recovery = copy.deepcopy(state['evidence_recovery'])
        old_complete = copy.deepcopy(state['records'])
        state['records'].append(failed_receipt(context.b,P.units(context.b)[1]))
        result = P.prepare_retry(context.b,context.digest,state,context.baseline_cost,P.PILOT_MAX,
            'SYNTHETIC-PILOT','b'*40)
        self.assertEqual(result['evidence_recovery'],old_recovery)
        self.assertEqual(result['records'],old_complete)
        P.validate_state(context.b,context.digest,result,context.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_no_automatic_retry_and_no_provider_during_prepare(self):
        provider = Provider()
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            P.run(self.b,self.digest,self.state,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-RETRY',provider,lambda _:None)
        self.assertEqual(provider.requests,[])
        with patch.object(R,'Provider') as factory:
            self.prepare()
            factory.assert_not_called()
        with patch('sys.argv',['label_pilot.py','prepare-retry']), patch.object(P,'PilotStore') as store:
            with self.assertRaisesRegex(R.Refused,'invalid_command'): P.main()
            store.assert_not_called()

    def test_cli_only_archives_saved_receipt_without_api_key_or_generation(self):
        preflight=[]; P.preflight(self.b,self.digest,Provider(),preflight.append)
        argv=['label_pilot.py','prepare-retry','--private-store','--archive-rejected-response',
              '--usd-cap','20','--approval-ref','SYNTHETIC-RETRY']
        output=io.StringIO()
        with patch('sys.argv',argv), patch.dict(os.environ,{'AI_LABEL_INPUT_SHA256':self.digest,'GITHUB_SHA':'b'*40},clear=True), \
             patch.object(P,'PilotStore') as factory, patch.object(R,'Provider') as provider, redirect_stdout(output):
            store=factory.return_value
            store.input_bytes.return_value=R.encode(self.b)
            store.baseline_bytes.return_value=self.baseline
            store.load_preflight.return_value=preflight[0]
            store.load.return_value=self.state
            P.main()
            provider.assert_not_called()
            store.persist.assert_called_once()
        result=json.loads(output.getvalue())
        self.assertEqual(result['status'],'rejected_response_archived')
        self.assertEqual(result['paid_requests'],0)
        self.assertEqual(result['completed_requests'],0)
        self.assertEqual(result['rejected_attempts'],1)


if __name__ == '__main__':
    unittest.main()
