"""The private-file plan preserves source bytes and decimal values without calling a service."""
import importlib.util
from pathlib import Path
import pytest
p=Path(__file__).resolve().parents[3]/'scripts/mu81-probability-plan.py'
spec=importlib.util.spec_from_file_location('probability_plan',p)
plan=importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)

def source(pi='0.00012345678901234567',se='0.00001112345678901234'):
    return ','.join(plan.HEADER)+'\n'+f'MU7-AREA-ONCOLOGY-901,AREA-ONCOLOGY,100,1,0.01,{pi},{se},1,1,1\n'

def test_source_is_unchanged_and_decimal_precision_is_preserved():
    raw=source()
    p=plan.prepare(raw,7,20000)
    assert p['source_csv']==raw
    assert p['file_sha256']==plan.sha(raw)
    assert p['rows'][0]['pi_i']=='0.00012345678901234567'
    assert p['rows'][0]['mc_standard_error']=='0.00001112345678901234'
    assert plan.canonical('1.0e-5')=='0.00001'
    assert plan.canonical('1.00000')=='1'
    assert plan.canonical('0.00000')=='0'

@pytest.mark.parametrize('value',['NaN','Infinity','-0.1','1.2','0','0.'+'0'*30+'1'])
def test_invalid_probability_is_never_rounded_or_coerced(value):
    with pytest.raises(ValueError):
        plan.prepare(source(value),7,20000)
