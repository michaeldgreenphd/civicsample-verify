#!/usr/bin/env python3
"""Prepare a private RPC payload from the unchanged probability CSV; never connects to a database."""
import argparse
import csv
from decimal import Decimal
import hashlib
import io
import json
import os
from pathlib import Path
import re

HEADER = ['unit_id','stratum','N_h','n_h','nominal_probability_n_h_over_N_h','pi_mc_ONE_PER_TRIAL','mc_se','pattern_group_units','weight_ONE_PER_TRIAL','ratio_mc_to_nominal']
def sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()

def canonical(value):
    number = Decimal(value)
    if not number.is_finite() or not 0 <= number <= 1:
        raise ValueError('Probability/error must be finite and in range')
    text = format(number, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    if not re.fullmatch(r'(?:0|1|0\.[0-9]{0,29}[1-9])', text):
        raise ValueError('Unsupported decimal precision; never rounded automatically')
    return text

def prepare(raw, seed, replicates):
    if not raw.endswith('\n') or '\r' in raw or '"' in raw or not 0 <= seed < 10**15 or not 1 < replicates < 10**9:
        raise ValueError('Unsupported CSV serialization or metadata')
    reader=csv.DictReader(io.StringIO(raw))
    if reader.fieldnames != HEADER:
        raise ValueError('Unexpected probability source header')
    rows=[]
    for r in reader:
        if not re.fullmatch(r'MU7-(AREA|ROW|SG)-[A-Z0-9_]{2,40}-[0-9]{3}',r['unit_id']):
            raise ValueError('Invalid unit identifier')
        pi=canonical(r['pi_mc_ONE_PER_TRIAL'])
        if pi=='0':
            raise ValueError('Inclusion probability must be positive')
        rows.append(dict(unit_id=r['unit_id'], pi_i=pi, mc_standard_error=canonical(r['mc_se'])))
    if not rows or len({r['unit_id'] for r in rows}) != len(rows):
        raise ValueError('Empty or duplicate probability inventory')
    rows.sort(key=lambda r:r['unit_id'])
    body=''.join(f"{r['unit_id']},{r['pi_i']},{r['mc_standard_error']}\n" for r in rows)
    return dict(binding_version='mu81-probability-1',method='MONTE_CARLO_ONE_PER_TRIAL',replicates=replicates,seed=seed,
                source_csv=raw,file_sha256=sha(raw),rows_sha256=sha(body),rows=rows)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--seed',type=int,required=True)
    ap.add_argument('--replicates',type=int,required=True)
    a=ap.parse_args()
    target=a.output.expanduser().resolve()
    if not a.output.is_absolute() or any((p/'.git').exists() for p in [target.parent,*target.parents]):
        raise SystemExit('Output must be an absolute private path outside every Git repository')
    payload=prepare(a.source.read_bytes().decode('utf-8'),a.seed,a.replicates)
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(payload,f,indent=2); f.write('\n')
    print(json.dumps({'status':'plan_only','rows':len(payload['rows']),'remote_requests':0}))
if __name__=='__main__':
    main()
