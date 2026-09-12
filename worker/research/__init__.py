"""Reproducible non-actual research, explicit holdout gates and read-only AI."""

from .ai import record_review, request_review, review_context, validate_review
from .backtest import compare_backtest
from .registry import (
    freeze_candidate, persist_trial, prepare_trial, record_trial_failure,
    register_experiment, register_trial, run_trial, unseal_holdout,
)
from .snapshot import snapshot_from_publications, validate_dataset, validate_plan

__all__ = ["record_review", "request_review", "review_context", "validate_review", "compare_backtest",
           "freeze_candidate", "persist_trial", "prepare_trial", "record_trial_failure",
           "register_experiment", "register_trial", "run_trial", "unseal_holdout",
           "snapshot_from_publications", "validate_dataset", "validate_plan"]
