"""
validation/mu7_bundle.py  (review design v7)

Canonical texts and hashes of bundle format 7.0, shared by validation/performance_analysis_v7.py and the synthetic
fixtures. They are the same texts the design scripts (review_design_v7/scripts/v7_common.py) and the database migration
(NNNN_v7_mapping_units.sql: private.mu7_design_row_text, private.mu7_assignment_row_text) hash; the test suite checks that
the three agree.

  design row      unit_id|nct_id|frame_id|stratum|N_h|n_h|allocation_option|overlap_setting|seed|prn_key
  assignment row  assignment_set_id|unit_id|mapping_code|assignment_code|assignment_status
  unit list       SHA-256 of the sorted unit IDs joined by line feeds
  set hashes      SHA-256 of the SHA-256 of each row text, rows ordered by unit_id (code-point order), joined by line feeds
  queue           SHA-256 of 'slot|position|unit_id' lines, slot then position, joined by line feeds
"""
from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def design_row_text(uid: str, nct_id: str, frame_id: str, stratum: str, N_h: int, n_h: int, option: str,
                    overlap_setting: str, seed: int, prn_key: str) -> str:
    return "|".join([uid, nct_id, frame_id, stratum, str(int(N_h)), str(int(n_h)), option, overlap_setting,
                     str(int(seed)), prn_key])


def assignment_row_text(assignment_set_id: str, uid: str, mapping_code: str, assignment_code: str,
                        assignment_status: str) -> str:
    return "|".join([assignment_set_id, uid, mapping_code, assignment_code, assignment_status])


def unit_list_sha256(unit_ids) -> str:
    return sha256_text("\n".join(sorted(unit_ids)))


def set_sha256(row_texts_by_unit: dict) -> str:
    """row_texts_by_unit: {unit_id: canonical row text}; rows ordered by unit_id in code-point order."""
    return sha256_text("\n".join(sha256_text(row_texts_by_unit[u]) for u in sorted(row_texts_by_unit)))


def queue_sha256(rows) -> str:
    """rows: iterable of (slot, position, unit_id)."""
    return sha256_text("\n".join(f"{s}|{p}|{u}" for s, p, u in sorted(rows, key=lambda r: (int(r[0]), int(r[1])))))
