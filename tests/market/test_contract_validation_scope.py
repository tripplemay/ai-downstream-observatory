"""Pure shape memoization must never retain input, permission or failure state."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from jsonschema import FormatChecker
from referencing import Registry, Resource

from worker.market import contracts
from worker.orchestration.db import WorkbenchError


class ContractValidationScopeTests(unittest.TestCase):
    def fixture(self, schema):
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "https://fictional.invalid/pure-shape.json", **schema}
        return {"fictional.json": schema}, Registry().with_resource(schema["$id"], Resource.from_contents(schema)), FormatChecker()

    def test_only_successful_exact_native_json_shape_checks_share_one_nested_operation(self):
        registry = self.fixture({"type": "object", "properties": {"value": {"type": "integer", "minimum": 1}}, "required": ["value"], "additionalProperties": False})
        original = contracts.Draft202012Validator.iter_errors
        with patch.object(contracts, "_schemas", return_value=registry), patch.object(contracts, "_validation_key", wraps=contracts._validation_key) as keys, \
                patch.object(contracts.Draft202012Validator, "iter_errors", autospec=True, side_effect=original) as checks:
            with contracts.contract_validation_scope():
                value = {"value": 1}; contracts.validate_contract(value, "fictional.json")
                memo = contracts._VALIDATION_SCOPE.get(); self.assertEqual(len(memo["keys"]), 1)
                with contracts.contract_validation_scope():
                    self.assertIs(contracts._VALIDATION_SCOPE.get(), memo)
                    contracts.validate_contract(deepcopy(value), "fictional.json"); self.assertEqual(len(memo["keys"]), 1)
                self.assertEqual(checks.call_count, 1)
                value["value"] = 0
                for _ in range(2):
                    with self.assertRaises(WorkbenchError): contracts.validate_contract(value, "fictional.json")
                self.assertEqual(len(memo["keys"]), 1)
                self.assertEqual(checks.call_count, 3)
                self.assertTrue(all(type(key[-1]) is bytes and len(key[-1]) == 32 for key in memo["keys"]))
            self.assertIsNone(contracts._VALIDATION_SCOPE.get()); self.assertEqual(keys.call_count, 4)
        with contracts.contract_validation_scope():
            self.assertEqual(contracts._VALIDATION_SCOPE.get()["keys"], set())

    def test_tuples_keys_and_subclasses_cannot_borrow_a_different_json_values_success(self):
        schema = self.fixture({"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "integer"}}}, "required": ["rows"], "additionalProperties": False})
        with patch.object(contracts, "_schemas", return_value=schema), contracts.contract_validation_scope():
            contracts.validate_contract({"rows": [1]}, "fictional.json")
            self.assertIsNone(contracts._validation_key({"rows": (1,)}, "fictional.json", None))
            with self.assertRaises(WorkbenchError): contracts.validate_contract({"rows": (1,)}, "fictional.json")
            self.assertIsNone(contracts._validation_key({1: "x"}, "fictional.json", None))
            class String(str): pass
            self.assertIsNone(contracts._validation_key({"rows": [String("1")]}, "fictional.json", None))
            self.assertNotEqual(contracts._validation_key(1, "fictional.json", None), contracts._validation_key(1.0, "fictional.json", None))
            cyclic = []; cyclic.append(cyclic)
            self.assertIsNone(contracts._validation_key(cyclic, "fictional.json", None))
            self.assertIsNone(contracts._validation_key(float("nan"), "fictional.json", None))

    def test_registry_changes_bounds_and_exceptions_do_not_extend_scope_or_reuse_an_old_rule(self):
        first = self.fixture({"type": "integer", "minimum": 0})
        second = self.fixture({"type": "integer", "minimum": 10})
        with patch.object(contracts, "_schemas", return_value=first) as schema, contracts.contract_validation_scope():
            contracts.validate_contract(1, "fictional.json"); schema.return_value = second
            with self.assertRaises(WorkbenchError): contracts.validate_contract(1, "fictional.json")
            self.assertEqual(contracts._VALIDATION_SCOPE.get()["keys"], set())
            for value in range(10, 10 + contracts._MAX_SCOPE_VALIDATIONS + 3): contracts.validate_contract(value, "fictional.json")
            self.assertEqual(len(contracts._VALIDATION_SCOPE.get()["keys"]), contracts._MAX_SCOPE_VALIDATIONS)
            self.assertIsNone(contracts._validation_key("x" * 65537, "fictional.json", None))
        with self.assertRaisesRegex(RuntimeError, "fictional-error"):
            with contracts.contract_validation_scope(): raise RuntimeError("fictional-error")
        self.assertIsNone(contracts._VALIDATION_SCOPE.get())


if __name__ == "__main__": unittest.main()
