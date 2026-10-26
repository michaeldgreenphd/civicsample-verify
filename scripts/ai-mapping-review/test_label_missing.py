"""Synthetic exhausted-output handling; missing is never a clinical assessment."""
import copy
import io
import json
import os
from contextlib import redirect_stdout
import unittest
from unittest.mock import patch

import label_pilot as P
import runner as R
from test_label_pilot import fixture, Provider, response
from test_label_retries import incomplete, failed_receipt
from test_runner import FakeProvider
import test_label_recovery as prior_recovery


class MissingLabelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle, _ = fixture()
        original = P.original(cls.bundle)
        for index, unit in enumerate(original['units']):
            unit['packet']['trial']['brief_title'] = 'Fictional missing-output trial ' + str(index)
        raw = R.encode(original)
        baseline = R.new_state(R.sha(raw),95_000_000,'SYNTHETIC-MISSING-BASELINE')
        R.run(original,R.sha(raw),baseline,95_000_000,'SYNTHETIC-MISSING-BASELINE',FakeProvider(),lambda _:None)
        cls.baseline = R.encode(baseline)
        cls.bundle['comparison_input'] = raw.decode()
        cls.bundle['baseline'] = {'input_sha256':R.sha(raw),'ledger_sha256':R.sha(cls.baseline)}

    def setUp(self):
        self.b = copy.deepcopy(self.bundle)
        self.digest = R.sha(R.encode(self.b))
        self.baseline_cost = P.verify_baseline(self.b, self.baseline)
        self.approval = 'SYNTHETIC-MISSING'
        self.state = P.new_state(self.digest, self.baseline_cost, P.PILOT_MAX, self.approval)
        self.exhausted = self.exhaust(self.state, P.SCREEN, P.units(self.b)[0]['unit_id'])

    def run_state(self, state, provider):
        return P.run(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,self.approval,provider,lambda _:None)

    def validate(self, state):
        P.validate_state(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,self.approval)

    def prepare(self, state):
        return P.prepare_retry(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,self.approval,'b'*40)

    def close(self, state):
        return P.record_missing_output(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,self.approval,'c'*40)

    def exhaust(self, state, model, uid):
        target = next(u for u in P.units(self.b) if u['unit_id'] == uid)
        request_hash = R.sha(R.encode(P.request_for(self.b,target,model)))
        def mutate(request, good):
            return incomplete(request) if R.sha(R.encode(request)) == request_hash else good
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            self.run_state(state,Provider(mutate))
        candidate = self.prepare(state)
        provider = Provider(mutate)
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            self.run_state(candidate,provider)
        self.assertEqual(len(provider.requests),1)
        return candidate

    def test_closure_preserves_both_receipts_and_cost_and_marks_only_missing(self):
        before = R.encode(self.exhausted)
        closed = self.close(self.exhausted)
        self.assertEqual(R.encode(self.exhausted),before)
        self.assertEqual(closed['records'],self.exhausted['records'])
        self.assertEqual(closed['rejected_attempts'],self.exhausted['rejected_attempts'])
        self.assertEqual(P.pilot_cost(closed),P.pilot_cost(self.exhausted))
        self.assertEqual(closed['format'],P.MISSING_LEDGER_FORMAT)
        self.assertEqual(closed['closed_failures'][0]['previous_ledger_sha256'],R.sha(before))
        self.assertNotIn('answer',closed['records'][0])
        self.assertEqual(P.summary(self.b,self.digest,closed)['screened_trials'],0)
        self.assertEqual(P.summary(self.b,self.digest,closed)['screen_missing_trials'],1)
        self.validate(closed)

    def test_resume_skips_exhausted_request_and_reports_missing_denominator(self):
        closed = self.close(self.exhausted)
        receipt = copy.deepcopy(closed['records'][0])
        first = P.units(self.b)[0]
        failed_hash = R.sha(R.encode(P.request_for(self.b,first,P.SCREEN)))
        provider = Provider()
        result = self.run_state(closed,provider)
        self.assertEqual(result['status'],'complete_with_missing_outputs')
        self.assertEqual(result['screened_trials'],99)
        self.assertEqual(result['screen_missing_trials'],1)
        self.assertEqual(result['audit_missing_trials'],0)
        self.assertEqual(result['audited_trials'],result['audit_required_trials'])
        self.assertTrue(all(R.sha(R.encode(r)) != failed_hash for r in provider.requests))
        self.assertEqual(closed['records'][0],receipt)
        self.validate(closed)
        second = Provider()
        self.assertEqual(self.run_state(closed,second),result)
        self.assertEqual(second.requests,[])

    def test_missing_screen_outside_controls_is_always_independently_audited(self):
        controls = set(P.audit_controls(self.b,self.digest))
        target = next(u for u in P.units(self.b) if u['unit_id'] not in controls)
        state = P.new_state(self.digest,self.baseline_cost,P.PILOT_MAX,self.approval)
        closed = self.close(self.exhaust(state,P.SCREEN,target['unit_id']))
        provider = Provider(); result = self.run_state(closed,provider)
        self.assertEqual(result['audit_required_trials'],21)
        self.assertIn(target['unit_id'],P.audit_ids(self.b,self.digest,closed['records']))
        audit_request = P.request_for(self.b,target,P.AUDIT)
        self.assertIn(audit_request,provider.requests)
        self.assertNotIn('assessments',audit_request['messages'][0]['content'])

    def test_later_retry_and_multiple_closures_preserve_all_prior_hashes(self):
        first = self.close(self.exhausted)
        original_receipts = copy.deepcopy(first['records'])
        original_closures = copy.deepcopy(first['closed_failures'])
        second = self.exhaust(first,P.SCREEN,P.units(self.b)[1]['unit_id'])
        closed = self.close(second)
        self.assertEqual(closed['records'][:1],original_receipts)
        self.assertEqual(closed['closed_failures'][:1],original_closures)
        self.assertEqual(len(closed['rejected_attempts']),2)
        result = self.run_state(closed,Provider())
        self.assertEqual(result['screened_trials'],98)
        self.assertEqual(result['screen_missing_trials'],2)
        self.validate(closed)

    def test_audit_can_be_missing_without_reclassifying_the_screen(self):
        state = self.close(self.exhausted)
        uid = P.audit_controls(self.b,self.digest)[0]
        closed = self.close(self.exhaust(state,P.AUDIT,uid))
        before = copy.deepcopy([r for r in closed['records'] if r['model'] == P.SCREEN])
        result = self.run_state(closed,Provider())
        self.assertEqual(result['status'],'complete_with_missing_outputs')
        self.assertEqual(result['audit_missing_trials'],1)
        self.assertEqual(result['audited_trials']+1,result['audit_required_trials'])
        self.assertEqual([r for r in closed['records'] if r['model'] == P.SCREEN],before)
        self.validate(closed)

    def test_first_failed_attempt_cannot_be_closed(self):
        state = P.new_state(self.digest,self.baseline_cost,P.PILOT_MAX,self.approval)
        state['records'].append(failed_receipt(self.b,P.units(self.b)[0]))
        with self.assertRaises(R.Refused): self.close(state)

    def test_valid_response_cannot_be_discarded_as_missing(self):
        state = copy.deepcopy(self.exhausted)
        request = P.request_for(self.b,P.units(self.b)[0],P.SCREEN)
        state['records'][-1]['response'] = response(request)
        with self.assertRaisesRegex(R.Refused,'invalid_missing_output'): self.close(state)

    def test_unknown_or_modified_receipt_cannot_be_closed(self):
        for key,value in [('failure_category','request_failed'),('status','reserved'),
                          ('charged_micro_usd',0),('usage',{}),('request_sha256','0'*64),
                          ('reserved_micro_usd',1)]:
            state=copy.deepcopy(self.exhausted); state['records'][-1][key]=value
            with self.assertRaises(R.Refused): self.close(state)
        for key in ('response','charged_micro_usd','usage'):
            state=copy.deepcopy(self.exhausted); del state['records'][-1][key]
            with self.assertRaises(R.Refused): self.close(state)
        state=copy.deepcopy(self.exhausted); state['records'][-1]['response']['model']=P.AUDIT
        with self.assertRaisesRegex(R.Refused,'model_mismatch'): self.close(state)

    def test_no_third_attempt_or_duplicate_closure(self):
        with self.assertRaisesRegex(R.Refused,'retry_limit_reached'): self.prepare(self.exhausted)
        closed=self.close(self.exhausted)
        with self.assertRaisesRegex(R.Refused,'retry_limit_reached'): self.prepare(closed)
        with self.assertRaisesRegex(R.Refused,'invalid_missing_output'): self.close(closed)

    def test_history_tampering_and_missing_metadata_refused(self):
        closed=self.close(self.exhausted); self.run_state(closed,Provider())
        for change in ('receipt','hash','previous','source','index','duplicate','drop','format','retry'):
            state=copy.deepcopy(closed); entry=state['closed_failures'][0]
            if change=='receipt': state['records'][0]['reserved_at']='changed'
            elif change=='hash': entry['record_sha256']='0'*64
            elif change=='previous': entry['previous_ledger_sha256']='0'*64
            elif change=='source': entry['source_commit']='not-a-commit'
            elif change=='index': entry['record_index']=1
            elif change=='duplicate': state['closed_failures'].append(copy.deepcopy(entry))
            elif change=='drop': del state['closed_failures']
            elif change=='format': state['format']=P.RETRIED_LEDGER_FORMAT
            else: state['rejected_attempts'][0]['record']['reserved_at']='changed'
            with self.assertRaises(R.Refused): self.validate(state)

    def test_missing_charges_reduce_both_caps_before_another_request(self):
        closed=self.close(self.exhausted)
        spent=P.pilot_cost(closed)
        bound=P.reservation(P.request_for(self.b,P.units(self.b)[1],P.SCREEN))
        # Build the history with the cap in place; changing a cap after closure is refused.
        for overall in (False,True):
            baseline = R.MAX_CAP_MICRO_USD-spent-bound+1 if overall else self.baseline_cost
            cap=P.PILOT_MAX if overall else spent+bound-1
            state=P.new_state(self.digest,baseline,cap,self.approval)
            state['records'].append(failed_receipt(self.b,P.units(self.b)[0]))
            state=P.prepare_retry(self.b,self.digest,state,baseline,cap,self.approval,'b'*40)
            state['records'].append(failed_receipt(self.b,P.units(self.b)[0]))
            state=P.record_missing_output(self.b,self.digest,state,baseline,cap,self.approval,'c'*40)
            provider=Provider()
            with self.assertRaisesRegex(R.Refused,'budget_exhausted'):
                P.run(self.b,self.digest,state,baseline,cap,self.approval,provider,lambda _:None)
            self.assertEqual(provider.requests,[])

    def test_old_evidence_recovery_stays_identical_through_closure(self):
        prior_recovery.ShortConditionRecoveryTests.setUpClass()
        context=prior_recovery.ShortConditionRecoveryTests(); context.setUp()
        state=context.recover(); before=copy.deepcopy(state)
        for i in range(2):
            state['records'].append(failed_receipt(context.b,P.units(context.b)[1]))
            if i==0:
                state=P.prepare_retry(context.b,context.digest,state,context.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT','b'*40)
        closed=P.record_missing_output(context.b,context.digest,state,context.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT','c'*40)
        self.assertEqual(closed['evidence_recovery'],before['evidence_recovery'])
        self.assertEqual(closed['records'][:1],before['records'])
        P.validate_state(context.b,context.digest,closed,context.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_no_automatic_closure_and_no_provider_in_explicit_closure(self):
        provider=Provider()
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'): self.run_state(self.exhausted,provider)
        self.assertEqual(provider.requests,[])
        with patch.object(R,'Provider') as factory:
            self.close(self.exhausted)
            factory.assert_not_called()
        with patch('sys.argv',['label_pilot.py','record-missing']), patch.object(P,'PilotStore') as store:
            with self.assertRaisesRegex(R.Refused,'invalid_command'): P.main()
            store.assert_not_called()

    def test_cli_persists_only_missing_marker_and_never_generates(self):
        preflight=[]; P.preflight(self.b,self.digest,Provider(),preflight.append)
        argv=['label_pilot.py','record-missing','--private-store','--record-missing-output',
              '--usd-cap','20','--approval-ref',self.approval]
        output=io.StringIO()
        with patch('sys.argv',argv), patch.dict(os.environ,{'AI_LABEL_INPUT_SHA256':self.digest,'GITHUB_SHA':'c'*40},clear=True), \
             patch.object(P,'PilotStore') as factory, patch.object(R,'Provider') as provider, redirect_stdout(output):
            store=factory.return_value
            store.input_bytes.return_value=R.encode(self.b)
            store.baseline_bytes.return_value=self.baseline
            store.load_preflight.return_value=preflight[0]
            store.load.return_value=self.exhausted
            P.main()
            provider.assert_not_called(); store.persist.assert_called_once()
        result=json.loads(output.getvalue())
        self.assertEqual(result['status'],'missing_output_recorded')
        self.assertEqual(result['paid_requests'],0)
        self.assertEqual(result['completed_requests'],0)
        self.assertEqual(result['missing_outputs'],1)
        for private in ('SYN-AI','Fictional','NOT_SUPPORTED','unit_id','reason'):
            self.assertNotIn(private,output.getvalue())


if __name__ == '__main__':
    unittest.main()
