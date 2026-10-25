"""Mutation checks against actual database-written synthetic bundle 8.1."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

import pandas as pd
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import performance_analysis_v8 as P  # noqa: E402


@pytest.fixture
def bundle(tmp_path):
    source = os.environ.get('MU81_DB_BUNDLE')
    if not source:
        pytest.skip('database bundle checked by tests/mu8-roundtrip.test.ts')
    dest = tmp_path / 'bundle'
    shutil.copytree(source, dest)
    return dest


def manifest(bundle):
    return json.loads((bundle / 'manifest.json').read_text())


def write_manifest(bundle, m):
    (bundle / 'manifest.json').write_text(json.dumps(m))


def replace_csv(bundle, name, f):
    p = bundle / name
    t = pd.read_csv(p, dtype=str, keep_default_na=False)
    f(t)
    t.to_csv(p, index=False, lineterminator='\n')
    m = manifest(bundle)
    m['files'][name] = hashlib.sha256(p.read_bytes()).hexdigest()
    m['row_counts'][name] = len(t)
    write_manifest(bundle, m)


def test_actual_bundle_counts_and_bound_weights(bundle):
    b = P.load_bundle(bundle, True, None)
    x = P.analysis_frame(b, None)
    assert len(x) == 100
    assert int(b['subtype_counts']['count'].sum()) == 4  # 2 reviewers x initial/effective, one eligible unit
    assert set(b['subtype_counts'].diabetes_subtype) == {'TYPE_2_STATED', 'TYPE_2_NOT_STATED'}
    if b['overlap'] == 'ONE_PER_TRIAL':
        p = b['bound_probabilities'].set_index('unit_id').pi_i.astype(float)
        assert all(abs(row.w - 1/p[row.unit_id]) < 1e-10 for row in x.itertuples())
    with pytest.raises(P.Refused, match='external override'):
        P.analysis_frame(b, bundle / 'irrelevant.csv')


@pytest.mark.parametrize('column,value', [('diabetes_subtype',''), ('diabetes_subtype','UNKNOWN'), ('mode','PILOT'), ('answer','DISAGREE'), ('revision_number','2'), ('content_sha256','broken')])
def test_subtype_mutations_refused_even_with_refreshed_file_hash(bundle,column,value):
    def change(t):
        i=t.index[t.diabetes_subtype.ne('')][0]
        t.loc[i,column]=value
    replace_csv(bundle,'subtype_observations.csv',change)
    with pytest.raises(P.Refused):
        P.load_bundle(bundle,True,None)


def test_subtype_cannot_appear_on_other_units(bundle):
    replace_csv(bundle,'subtype_observations.csv',lambda t: t.loc.__setitem__((t.index[t.diabetes_subtype.eq('')][0],'diabetes_subtype'),'TYPE_2_STATED'))
    with pytest.raises(P.Refused,match='ineligible'):
        P.load_bundle(bundle,True,None)


@pytest.mark.parametrize('key,value', [('seed',2),('replicates',1),('rows_sha256','0'*64),('binding_sha256','0'*64),('method','UNKNOWN')])
def test_probability_metadata_tampering(bundle,key,value):
    m=manifest(bundle)
    if m['design']['overlap_setting'] != 'ONE_PER_TRIAL':
        return  # ALLOW correctly has no probability binding
    m['probability_binding'][key]=value
    write_manifest(bundle,m)
    with pytest.raises(P.Refused):
        P.load_bundle(bundle,True,None)


def test_probability_file_cannot_be_replaced_even_with_new_manifest_checksum(bundle):
    m=manifest(bundle)
    if m['design']['overlap_setting'] != 'ONE_PER_TRIAL':
        return
    replace_csv(bundle,'probabilities.csv',lambda t: t.loc.__setitem__((0,'pi_i'),'0.9'))
    with pytest.raises(P.Refused,match='digest mismatch'):
        P.load_bundle(bundle,True,None)
