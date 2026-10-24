"""Synthetic regression cases for database export timestamp representations."""

import pandas as pd
import pytest

from analysis import performance_analysis_v4 as pa4
from analysis import performance_analysis_v5 as pa5


@pytest.mark.parametrize("analysis", [pa4, pa5])
@pytest.mark.parametrize("reverse", [False, True])
def test_timestamp_precision_can_vary_within_one_export(analysis, reverse):
    values = [
        "2026-10-24T12:00:00.123Z",
        "2026-10-24T12:00:01Z",
        "2026-10-24T12:00:02.123456+00:00",
        "2026-10-24T08:00:03-04:00",
    ]
    if reverse:
        values.reverse()
    source = pd.Series(values, index=[9, 4, 7, 2])
    actual = analysis._ts_col(source, "first_submitted_at")
    expected = pd.Series([pd.Timestamp(value) for value in values], index=source.index)
    expected = pd.to_datetime(expected, utc=True)
    pd.testing.assert_series_equal(actual, expected, check_dtype=False)


@pytest.mark.parametrize("analysis", [pa4, pa5])
@pytest.mark.parametrize("invalid", [None, "", "not-a-time", "2026-02-30T12:00:00Z"])
def test_unreadable_or_missing_timestamp_still_refuses_export(analysis, invalid):
    with pytest.raises(analysis.ExportError, match="missing or unreadable timestamps"):
        analysis._ts_col(pd.Series(["2026-10-24T12:00:00Z", invalid]), "first_submitted_at")
