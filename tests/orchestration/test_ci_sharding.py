import unittest

from scripts.ci_python_tests import flatten, partition


def fictional_case(module, name):
    case_type = type(name, (unittest.TestCase,), {"__module__": module, "test_fixture": lambda self: None})
    return case_type("test_fixture")


class CiShardingTests(unittest.TestCase):
    def test_nested_suites_preserve_order_and_all_cases(self):
        cases = [fictional_case("a", "First"), fictional_case("b", "Second")]
        self.assertEqual(list(flatten(unittest.TestSuite([unittest.TestSuite([cases[0]]), cases[1]]))), cases)

    def test_partition_is_exhaustive_disjoint_and_keeps_modules_together(self):
        cases = [fictional_case(module, name) for module, name in [("a", "First"), ("a", "Second"), ("b", "Third"), ("c", "Fourth")]]
        groups = partition(cases, 2)
        self.assertEqual({case.id() for group in groups for case in group}, {case.id() for case in cases})
        self.assertEqual(sum(map(len, groups)), len(cases))
        self.assertTrue(all(case in groups[0] for case in cases[:2]))
        self.assertEqual([case.id() for case in groups[0]], [cases[0].id(), cases[1].id(), cases[3].id()])

    def test_assignment_does_not_depend_on_discovery_filesystem_order(self):
        cases = [fictional_case(module, "Fixture") for module in ("c", "a", "b")]
        mapping = lambda groups: {case.id(): index for index, group in enumerate(groups) for case in group}
        self.assertEqual(mapping(partition(cases, 3)), mapping(partition(list(reversed(cases)), 3)))

    def test_empty_discovery_duplicates_and_invalid_counts_are_rejected(self):
        case = fictional_case("a", "Fixture")
        for cases, count in (([], 1), ([case, case], 1), ([case], 0), ([case], 33), ([case], True)):
            with self.subTest(count=count), self.assertRaises(ValueError):
                partition(cases, count)
