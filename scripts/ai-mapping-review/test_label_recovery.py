"""Narrow revalidation of a saved fictional response; no provider or remote calls."""
import copy
import io
import json
import os
from contextlib import redirect_stdout
import unittest
from unittest.mock import patch

import label_pilot as P
import runner as R
from test_label_pilot import fixture, response, Provider
from test_runner import FakeProvider as BaselineProvider


class ShortConditionRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        b, _ = fixture()
        old = P.original(b)
        old['units'][0]['packet']['trial']['conditions_registered'] = ['Asthma']
        raw = R.encode(old)
        baseline = R.new_state(R.sha(raw), 95_000_000, 'SYNTHETIC-BASELINE')
        R.run(old, R.sha(raw), baseline, 95_000_000, 'SYNTHETIC-BASELINE', BaselineProvider(), lambda _: None)
        b['comparison_input'] = raw.decode()
        b['baseline'] = {'input_sha256': R.sha(raw), 'ledger_sha256': R.sha(R.encode(baseline))}
        cls.bundle = b
        cls.baseline_raw = R.encode(baseline)

    def setUp(self):
        self.b = copy.deepcopy(self.bundle)
        self.digest = R.sha(R.encode(self.b))
        self.baseline_cost = P.verify_baseline(self.b, self.baseline_raw)
        self.unit = P.units(self.b)[0]
        self.request = P.request_for(self.b, self.unit, P.SCREEN)
        self.response = response(self.request, change=True, category='ROW_AST')
        answer = json.loads(self.response['content'][0]['text'])
        next(a for a in answer['assessments'] if a['id']=='ROW_AST')['evidence'] = [
            {'field':'conditions_registered.0', 'quote':'Asthma'}]
        self.response['content'][0]['text'] = json.dumps(answer)
        self.state = P.new_state(self.digest, self.baseline_cost, P.PILOT_MAX, 'SYNTHETIC-PILOT')
        charge, usage = R.usage_cost(self.response, P.SCREEN)
        self.state['records'].append({'model':P.SCREEN, 'unit_id':self.unit['unit_id'], 'status':'unreconciled',
            'request_sha256':R.sha(R.encode(self.request)), 'reserved_micro_usd':P.reservation(self.request),
            'reserved_at':R.now(), 'response':copy.deepcopy(self.response), 'charged_micro_usd':charge,
            'usage':usage, 'failure_category':'invalid_evidence'})

    def recover(self, state=None):
        return P.recover_short_condition(self.b,self.digest,state or self.state,self.baseline_cost,
                                         P.PILOT_MAX,'SYNTHETIC-PILOT','a'*40)

    def test_complete_short_condition_is_valid_but_old_validator_reproduces_failure(self):
        with self.assertRaisesRegex(R.Refused,'invalid_evidence'):
            P.validate_response(self.response,P.SCREEN,self.unit,legacy_evidence=True)
        self.assertEqual(len(P.validate_response(self.response,P.SCREEN,self.unit)['assessments']),20)
        for field,quote,source,expected in [
            ('conditions_registered.0','Asthma','Asthma',True),
            ('conditions_registered.0','HIV','HIV',True),
            ('conditions_registered.0','MS','MS',True),
            ('conditions_registered.0','A','A',False),
            ('conditions_registered.0','Asthma','Severe Asthma',False),
            ('conditions_registered.0','asthma','Asthma',False),
            ('conditions_registered.0',' Asthma','Asthma',False),
            ('brief_title','Asthma','Asthma',False),
            ('condition_mesh_headings.0','Asthma','Asthma',False),
            ('conditions_registered.invalid','Asthma','Asthma',False),
        ]:
            self.assertEqual(P.short_condition_quote(field,quote,{field:source}),expected)

    def test_recovery_preserves_every_raw_response_prior_charge_and_archives_failure(self):
        before=R.encode(self.state)
        new=self.recover()
        self.assertEqual(R.encode(self.state),before)
        self.assertEqual(new['format'],P.RECOVERED_LEDGER_FORMAT)
        self.assertEqual(new['evidence_recovery']['previous_ledger_sha256'],R.sha(before))
        self.assertEqual(R.encode(new['evidence_recovery']['previous_ledger']),before)
        recovered=new['records'][0]
        for key in ('response','charged_micro_usd','usage','reserved_micro_usd','request_sha256','failure_category'):
            self.assertEqual(recovered[key],self.state['records'][0][key])
        self.assertEqual(P.pilot_cost(new),P.pilot_cost(self.state))
        self.assertEqual(recovered['status'],'complete')
        P.validate_state(self.b,self.digest,new,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_run_refuses_unreconciled_response_until_explicit_recovery(self):
        with self.assertRaisesRegex(R.Refused,'unreconciled_request'):
            P.run(self.b,self.digest,self.state,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT',Provider(),lambda _:None)

    def test_resume_does_not_regenerate_saved_response(self):
        new=self.recover(); provider=Provider()
        result=P.run(self.b,self.digest,new,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT',provider,lambda _:None)
        self.assertEqual(result['status'],'complete')
        # The stored screening request is not sent again, but its changed trial gets an independent audit.
        self.assertFalse(any(req==self.request for req in provider.requests))
        self.assertTrue(any(req['model']==P.AUDIT and req['messages']==self.request['messages'] for req in provider.requests))
        P.validate_state(self.b,self.digest,new,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_second_recovery_and_disguised_ledger_version_refused(self):
        new=self.recover()
        with self.assertRaisesRegex(R.Refused,'recovery_already_recorded'):self.recover(new)
        for change in ('drop_archive','old_format','missing_archive'):
            bad=copy.deepcopy(new)
            if change=='old_format':bad['format']=P.LEDGER_FORMAT
            elif change=='drop_archive':bad['evidence_recovery']={}
            else:del bad['evidence_recovery']
            with self.assertRaises(R.Refused):
                P.validate_state(self.b,self.digest,bad,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_unsupported_fragment_fabrication_and_other_response_errors_cannot_recover(self):
        for change in ('fragment','wrong_field','wrong_model','truncated','wrong_decision','missing_quote'):
            state=copy.deepcopy(self.state); r=state['records'][0]; data=json.loads(r['response']['content'][0]['text'])
            item=next(a for a in data['assessments'] if a['id']=='ROW_AST')
            if change=='fragment':item['evidence'][0]['quote']='Ast'
            elif change=='wrong_field':item['evidence'][0]['field']='brief_title'
            elif change=='wrong_model':r['response']['model']=P.AUDIT
            elif change=='truncated':r['response']['stop_reason']='max_tokens'
            elif change=='wrong_decision':item['decision']='BAD'
            elif change=='missing_quote':item['evidence']=[]
            r['response']['content'][0]['text']=json.dumps(data)
            with self.assertRaises(R.Refused): self.recover(state)

    def test_usage_receipt_request_binding_budget_and_failure_kind_all_still_required(self):
        for key,value in [('charged_micro_usd',0),('request_sha256','0'*64),('reserved_micro_usd',1),
                          ('failure_category','provider_timeout'),('status','reserved'),('usage',{})]:
            state=copy.deepcopy(self.state);state['records'][0][key]=value
            with self.assertRaises(R.Refused):self.recover(state)
        state=copy.deepcopy(self.state);state['pilot_cap_micro_usd']=19_000_000
        with self.assertRaisesRegex(R.Refused,'ledger_binding_mismatch'):self.recover(state)

    def test_archive_and_repaired_prefix_cannot_be_changed_on_resume(self):
        new=self.recover()
        for change in ('archive','hash','cost','answer','response','timestamp','source'):
            state=copy.deepcopy(new)
            if change=='archive':state['evidence_recovery']['previous_ledger']['records'][0]['failure_category']='other'
            elif change=='hash':state['evidence_recovery']['previous_ledger_sha256']='0'*64
            elif change=='cost':state['records'][0]['charged_micro_usd']=0
            elif change=='answer':state['records'][0]['answer']['assessments'][0]['decision']='INSUFFICIENT_INFORMATION'
            elif change=='response':state['records'][0]['response']['content'][0]['text']='{}'
            elif change=='timestamp':state['records'][0]['completed_at']='other'
            else:state['evidence_recovery']['source_commit']='not-a-commit'
            with self.assertRaises(R.Refused):
                P.validate_state(self.b,self.digest,state,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_previously_complete_prefix_is_retained(self):
        previous=P.units(self.b)[1]
        request=P.request_for(self.b,previous,P.SCREEN); res=response(request)
        charge,usage=R.usage_cost(res,P.SCREEN)
        record={'model':P.SCREEN,'unit_id':previous['unit_id'],'status':'complete','request_sha256':R.sha(R.encode(request)),
                'reserved_micro_usd':P.reservation(request),'reserved_at':R.now(),'response':res,'charged_micro_usd':charge,
                'usage':usage,'answer':P.validate_response(res,P.SCREEN,previous),'completed_at':R.now()}
        self.state['records'].insert(0,record)
        new=self.recover();self.assertEqual(new['records'][0],record)
        new['records'][0]['answer']['assessments'][0]['reason']='changed'
        with self.assertRaises(R.Refused):P.validate_state(self.b,self.digest,new,self.baseline_cost,P.PILOT_MAX,'SYNTHETIC-PILOT')

    def test_recovery_is_offline_and_requires_explicit_acknowledgement(self):
        with patch.object(R,'Provider') as provider:
            self.recover();provider.assert_not_called()
        with patch('sys.argv',['label_pilot.py','recover-evidence']), patch.object(P,'PilotStore') as store:
            with self.assertRaisesRegex(R.Refused,'invalid_command'):P.main()
            store.assert_not_called()

    def test_cli_recovery_cannot_construct_provider_or_generate_a_paid_request(self):
        reports=[]
        P.preflight(self.b,self.digest,Provider(),reports.append)
        before=copy.deepcopy(self.state)
        args=['label_pilot.py','recover-evidence','--private-store','--reconcile-stored-response',
              '--usd-cap','20','--approval-ref','SYNTHETIC-PILOT']
        output=io.StringIO()
        with patch('sys.argv',args), patch.dict(os.environ,{'AI_LABEL_INPUT_SHA256':self.digest,'GITHUB_SHA':'a'*40},clear=True), \
             patch.object(P,'PilotStore') as factory, patch.object(R,'Provider') as provider, redirect_stdout(output):
            store=factory.return_value
            store.input_bytes.return_value=R.encode(self.b)
            store.baseline_bytes.return_value=self.baseline_raw
            store.load_preflight.return_value=reports[0]
            store.load.return_value=self.state
            P.main()
            provider.assert_not_called()
            store.persist.assert_called_once()
            saved=store.persist.call_args.args[0]
        self.assertEqual(self.state,before)
        self.assertEqual(json.loads(output.getvalue())['paid_requests'],0)
        self.assertEqual(saved['records'][0]['response'],self.response)
        self.assertNotIn('Asthma',output.getvalue())


if __name__=='__main__':unittest.main()
