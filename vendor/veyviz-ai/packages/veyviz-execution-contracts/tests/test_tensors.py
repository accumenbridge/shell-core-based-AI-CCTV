import unittest

import numpy as np

from veyviz_execution_contracts import TensorContractError, TensorSpec


class TensorTests(unittest.TestCase):
    def test_validates_exact_finite_contiguous_float32(self):
        spec = TensorSpec("input", (2, 2))
        spec.validate(np.zeros((2, 2), dtype=np.float32))
        for value in (
            None,
            [[0]],
            np.zeros((2, 2)),
            np.zeros((2, 1), dtype=np.float32),
            np.zeros((2, 2), dtype=np.float32).T,
            np.full((2, 2), np.nan, dtype=np.float32),
        ):
            with self.assertRaises(TensorContractError):
                spec.validate(value)

    def test_metadata_is_bounded_and_snapshotted(self):
        shape = [2, 2]
        spec = TensorSpec("input", shape)
        shape[0] = 5
        self.assertEqual(spec.shape, (2, 2))
        for name, shape in (
            ("", (1,)),
            (None, (1,)),
            ("a/b", (1,)),
            ("x", None),
            ("x", ()),
            ("x", (True,)),
            ("x", (0,)),
            ("x", ("dynamic",)),
            ("x", (1,) * 9),
            ("x", (16_777_217,)),
        ):
            with self.assertRaises(TensorContractError):
                TensorSpec(name, shape)


if __name__ == "__main__":
    unittest.main()
