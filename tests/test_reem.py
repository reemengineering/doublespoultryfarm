"""Test suite for the DOUBLES POULTRY FARM weighing terminal.

One module covers the lot: the shop's rounding rule and verdict, the tare zero
point, the YH-T7E frame parser and stream buffering, the whole REST API flow,
and that the two pages and their assets are served.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

# Point the app at a throwaway data directory before anything imports ``reem``:
# the configuration is read once, at import time.
_TMP = Path(tempfile.mkdtemp(prefix="reem-test-"))
os.environ["DATA_DIR"] = str(_TMP)
os.environ["DB_PATH"] = str(_TMP / "test.db")
os.environ["SCALE_ENABLED"] = "0"
# No outbound calls to the translation / speech services from the test suite.
os.environ["REEM_DISABLE_REMOTE"] = "1"

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from reem import create_app, domain  # noqa: E402
from reem.domain import ScaleService, TareBaseline, parse_yaohua_frame  # noqa: E402


# ---------------------------------------------------------------------------
# The shop's rounding rule and the weighing verdict
# ---------------------------------------------------------------------------

class RoundOffWeightTests(unittest.TestCase):
    def test_rounds_down_to_whole_kilograms(self) -> None:
        self.assertEqual(domain.round_off_weight(50.8), 50)
        self.assertEqual(domain.round_off_weight(51.999), 51)
        self.assertEqual(domain.round_off_weight(50.0), 50)

    def test_absorbs_floating_point_noise(self) -> None:
        # 50.9999999999 is 51.000 seen through a float, not 50.999 kg.
        self.assertEqual(domain.round_off_weight(50.9999999999), 51)

    def test_negative_readings_floor_toward_zero(self) -> None:
        # An empty pan may sit just under zero; it must not become -1 kg.
        self.assertEqual(domain.round_off_weight(-0.5), 0)
        self.assertEqual(domain.round_off_weight(-0.0001), 0)

    def test_junk_is_zero(self) -> None:
        self.assertEqual(domain.round_off_weight(None), 0)  # type: ignore[arg-type]
        self.assertEqual(domain.round_off_weight(float("inf")), 0)


class RoundTargetWeightTests(unittest.TestCase):
    def test_rounds_down(self) -> None:
        self.assertEqual(domain.round_target_weight(50.8), 50)

    def test_never_below_one_kilogram(self) -> None:
        self.assertEqual(domain.round_target_weight(0.4), 1)
        self.assertEqual(domain.round_target_weight(0), 1)

    def test_rounding_note_only_when_it_changes(self) -> None:
        self.assertEqual(
            domain.target_rounding_note(50.8), "50.8 will be weighed as 50 kg"
        )
        self.assertIsNone(domain.target_rounding_note(50))
        self.assertIsNone(domain.target_rounding_note(0))


class EvaluateReadingTests(unittest.TestCase):
    def test_accepts_the_whole_kilogram_band(self) -> None:
        for reading in (50.0, 50.4, 50.999):
            verdict = domain.evaluate_reading(50, reading)
            self.assertEqual(verdict["type"], "accepted", reading)

    def test_overweight_starts_at_the_next_kilogram(self) -> None:
        verdict = domain.evaluate_reading(50, 51.0)
        self.assertEqual(verdict["type"], "overweight")
        self.assertEqual(verdict["detail"], "Remove 1.000 kg")

    def test_underweight(self) -> None:
        verdict = domain.evaluate_reading(50, 49.0)
        self.assertEqual(verdict["type"], "underweight")
        self.assertEqual(verdict["detail"], "Add 1.000 kg")

    def test_no_reading_is_neutral(self) -> None:
        verdict = domain.evaluate_reading(50, None)
        self.assertEqual(verdict["type"], "neutral")
        self.assertFalse(verdict["correct"])


class JsRoundTests(unittest.TestCase):
    def test_half_rounds_up_like_javascript(self) -> None:
        self.assertEqual(domain.js_round(0.5), 1)
        self.assertEqual(domain.js_round(1.5), 2)
        self.assertEqual(domain.js_round(-0.5), 0)


# ---------------------------------------------------------------------------
# The tare zero point
# ---------------------------------------------------------------------------

class TareBaselineTests(unittest.TestCase):
    def test_only_an_at_or_below_zero_reading_proves_an_empty_pan(self) -> None:
        tare = TareBaseline()
        self.assertTrue(tare.adopt_empty_pan(-0.2))
        self.assertTrue(tare.is_established())
        self.assertEqual(tare.base_value(), -0.2)

    def test_positive_reading_never_becomes_the_zero_point(self) -> None:
        tare = TareBaseline()
        self.assertFalse(tare.adopt_empty_pan(12.5))
        self.assertFalse(tare.is_established())

    def test_net_subtracts_the_zero_point(self) -> None:
        tare = TareBaseline()
        tare.adopt_empty_pan(0.0)
        self.assertEqual(tare.net(12.4), 12.4)

    def test_net_never_goes_negative(self) -> None:
        tare = TareBaseline()
        tare.zero_at(5.0)
        self.assertEqual(tare.net(3.0), 0.0)

    def test_net_is_none_without_a_reading(self) -> None:
        tare = TareBaseline()
        self.assertIsNone(tare.net(None))

    def test_carry_moves_the_zero_point_to_the_accepted_total(self) -> None:
        tare = TareBaseline()
        tare.adopt_empty_pan(0.0)
        tare.carry(30.6)
        self.assertEqual(tare.base_value(), 30.6)
        # Next line: 50.0 on the running total is 19.4 kg of the new item.
        self.assertEqual(tare.net(50.0), 19.4)

    def test_under_base_flags_material_leaving_the_pan(self) -> None:
        tare = TareBaseline()
        tare.zero_at(20.0)
        self.assertFalse(tare.under_base(19.9))
        self.assertTrue(tare.under_base(19.0))
        # Never flags before a zero point exists.
        self.assertFalse(TareBaseline().under_base(-100))


# ---------------------------------------------------------------------------
# The YH-T7E frame parser and the byte stream that feeds it
# ---------------------------------------------------------------------------

class ParseFrameTests(unittest.TestCase):
    def test_positive_frame(self) -> None:
        # '=' then the digits reversed, sign character last.
        self.assertEqual(parse_yaohua_frame("=052.100"), 1.25)

    def test_negative_frame(self) -> None:
        self.assertEqual(parse_yaohua_frame("=003.00-"), -0.3)

    def test_zero_frame(self) -> None:
        self.assertEqual(parse_yaohua_frame("=000.000"), 0.0)

    def test_rejects_short_or_misaligned_frames(self) -> None:
        self.assertIsNone(parse_yaohua_frame(None))
        self.assertIsNone(parse_yaohua_frame(""))
        self.assertIsNone(parse_yaohua_frame("=052.1"))
        self.assertIsNone(parse_yaohua_frame("X052.100"))

    def test_rejects_non_numeric_payload(self) -> None:
        self.assertIsNone(parse_yaohua_frame("=abcdef0"))


class StreamBufferTests(unittest.TestCase):
    """_on_data splits a byte stream into frames and keeps only real ones."""

    def setUp(self) -> None:
        self.service = ScaleService(port_path="COM_TEST")
        self.readings: list[dict] = []
        self.service.on_reading(self.readings.append)

    def test_one_frame_per_chunk(self) -> None:
        self.service._on_data(b"=052.100")
        self.assertEqual(len(self.readings), 1)
        self.assertEqual(self.readings[0]["weight"], 1.25)
        self.assertEqual(self.readings[0]["raw"], "=052.100")

    def test_junk_between_frames_is_ignored(self) -> None:
        self.service._on_data(b"noise=052.100more junk=003.00-")
        self.assertEqual([r["weight"] for r in self.readings], [1.25, -0.3])

    def test_frame_split_across_chunks_is_reassembled(self) -> None:
        self.service._on_data(b"=052.")
        self.assertEqual(self.readings, [])
        self.service._on_data(b"100")
        self.assertEqual([r["weight"] for r in self.readings], [1.25])

    def test_reading_goes_stale_after_the_age_limit(self) -> None:
        self.service._on_data(b"=052.100")
        self.assertIsNotNone(self.service.get_reading())
        # Backdate the frame past the 2 s limit.
        self.service._reading["receivedAt"] = "2000-01-01T00:00:00Z"
        self.assertIsNone(self.service.get_reading())


# ---------------------------------------------------------------------------
# End-to-end checks of the REST API the UI talks to
# ---------------------------------------------------------------------------

def json_of(response):
    try:
        return response.get_json()
    except Exception:  # noqa: BLE001
        return None


class ApiFlowTests(unittest.TestCase):
    """The whole flow runs once in setUpClass and the methods assert on it."""

    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app()
        cls.client = cls.app.test_client()

        cls.r = {}

        # -- item master ---------------------------------------------------
        cls.r["items"] = cls.client.get("/api/items")
        items = json_of(cls.r["items"])

        cls.r["create_item"] = cls.client.post(
            "/api/items", json={"name": "Turmeric", "name_hi": "हल्दी"}
        )
        cls.created_item = json_of(cls.r["create_item"])

        cls.r["dup_item"] = cls.client.post("/api/items", json={"name": "Turmeric"})
        cls.r["blank_item"] = cls.client.post("/api/items", json={"name": "   "})

        cls.r["update_item"] = cls.client.put(
            f"/api/items/{cls.created_item['id']}",
            json={
                "name": "Turmeric Powder",
                "name_hi": "हल्दी पाउडर",
            },
        )
        cls.r["update_item_dup"] = cls.client.put(
            f"/api/items/{cls.created_item['id']}", json={"name": "Rice"}
        )
        cls.r["update_missing_item"] = cls.client.put(
            "/api/items/999999", json={"name": "Nope"}
        )

        # -- formulas ------------------------------------------------------
        cls.r["formula"] = cls.client.post(
            "/api/formulas",
            json={
                "name": "Mix A",
                "lines": [
                    {"itemId": items[0]["id"], "requiredWeight": 50.8},
                    {"itemId": items[1]["id"], "requiredWeight": 0.4},
                ],
            },
        )
        cls.formula = json_of(cls.r["formula"])

        cls.r["empty_formula"] = cls.client.post(
            "/api/formulas", json={"name": "Empty", "lines": []}
        )
        cls.r["dup_formula"] = cls.client.post(
            "/api/formulas",
            json={"name": "Mix A", "lines": [{"itemId": items[0]["id"], "requiredWeight": 10}]},
        )
        cls.r["update_formula"] = cls.client.put(
            f"/api/formulas/{cls.formula['id']}",
            json={"name": "Mix A2", "lines": [{"itemId": items[0]["id"], "requiredWeight": 12}]},
        )
        cls.r["delete_used_item"] = cls.client.delete(f"/api/items/{items[0]['id']}")
        cls.r["soft_delete_formula"] = cls.client.delete(f"/api/formulas/{cls.formula['id']}")

        cls.r["malformed_json"] = cls.client.post(
            "/api/items", data="{bad json", content_type="application/json"
        )
        cls.r["unknown_api"] = cls.client.get("/api/nope")

        # -- scale / power --------------------------------------------------
        cls.r["ports"] = cls.client.get("/api/scale/ports")
        cls.r["connect"] = cls.client.post("/api/scale/connect", json={"port": "COM1"})
        cls.r["shutdown_guard"] = cls.client.post("/api/shutdown", json={"confirm": False})
        cls.r["shutdown_dry"] = cls.client.post(
            "/api/shutdown", json={"confirm": True, "dryRun": True}
        )

    # -- health ------------------------------------------------------------

    def test_health(self) -> None:
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(json_of(r)["ok"])

    # -- item master -------------------------------------------------------

    def test_seeded_item_master(self) -> None:
        self.assertEqual(self.r["items"].status_code, 200)
        items = json_of(self.r["items"])
        self.assertEqual(len(items), 6)
        self.assertEqual(items[0]["code"], "RM-01")

    def test_create_item(self) -> None:
        self.assertEqual(self.r["create_item"].status_code, 201)
        self.assertEqual(self.created_item["code"], "RM-07")
        self.assertEqual(self.created_item["names"]["hi"], "हल्दी")

    def test_duplicate_item_conflicts(self) -> None:
        self.assertEqual(self.r["dup_item"].status_code, 409)

    def test_item_name_is_required(self) -> None:
        self.assertEqual(self.r["blank_item"].status_code, 400)

    def test_update_item_names(self) -> None:
        self.assertEqual(self.r["update_item"].status_code, 200)
        updated = json_of(self.r["update_item"])
        self.assertEqual(updated["name"], "Turmeric Powder")
        self.assertEqual(updated["names"]["hi"], "हल्दी पाउडर")

    def test_update_item_to_an_existing_name_conflicts(self) -> None:
        self.assertEqual(self.r["update_item_dup"].status_code, 409)

    def test_update_missing_item_is_not_found(self) -> None:
        self.assertEqual(self.r["update_missing_item"].status_code, 404)

    # -- formulas ----------------------------------------------------------

    def test_create_formula(self) -> None:
        self.assertEqual(self.r["formula"].status_code, 201)

    def test_formula_targets_round_down_with_a_one_kg_floor(self) -> None:
        self.assertEqual(self.formula["lines"][0]["requiredWeight"], 50)
        self.assertEqual(self.formula["lines"][1]["requiredWeight"], 1)
        self.assertEqual(self.formula["totalWeight"], 51)

    def test_formula_needs_a_line(self) -> None:
        self.assertEqual(self.r["empty_formula"].status_code, 400)

    def test_duplicate_formula_conflicts(self) -> None:
        self.assertEqual(self.r["dup_formula"].status_code, 409)

    def test_update_formula(self) -> None:
        self.assertEqual(self.r["update_formula"].status_code, 200)
        self.assertEqual(json_of(self.r["update_formula"])["name"], "Mix A2")

    def test_item_used_by_a_formula_cannot_be_deleted(self) -> None:
        self.assertEqual(self.r["delete_used_item"].status_code, 409)

    # -- data logging is gone ----------------------------------------------

    def test_weighings_are_not_recorded_any_more(self) -> None:
        self.assertEqual(self.client.post("/api/weighings", json={}).status_code, 404)
        self.assertEqual(self.client.get("/api/reports/overview").status_code, 404)

    def test_malformed_json_is_a_clean_400(self) -> None:
        self.assertEqual(self.r["malformed_json"].status_code, 400)

    def test_unknown_api_endpoint_returns_json_404(self) -> None:
        self.assertEqual(self.r["unknown_api"].status_code, 404)
        self.assertEqual(json_of(self.r["unknown_api"])["error"], "Unknown API endpoint")

    # -- scale / power ----------------------------------------------------

    def test_scale_reports_disabled_when_switched_off(self) -> None:
        self.assertEqual(self.r["ports"].status_code, 200)
        self.assertFalse(json_of(self.r["ports"])["enabled"])

    def test_connecting_a_disabled_scale_is_unavailable(self) -> None:
        self.assertEqual(self.r["connect"].status_code, 503)

    def test_shutdown_requires_confirmation(self) -> None:
        self.assertEqual(self.r["shutdown_guard"].status_code, 400)
        self.assertEqual(self.r["shutdown_dry"].status_code, 200)
        self.assertTrue(json_of(self.r["shutdown_dry"])["dryRun"])


class PageServingTests(unittest.TestCase):
    """The kiosk, the staff terminal and their assets are all served."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app()
        cls.client = cls.app.test_client()

    def test_kiosk_page(self) -> None:
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"app.js", r.data)

    def test_staff_page_loads_the_staff_app(self) -> None:
        r = self.client.get("/staff/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"staff.js", r.data)
        # The staff styles are folded into one sheet, scoped by this class.
        self.assertIn(b"page-staff", r.data)

    def test_static_assets_are_served(self) -> None:
        for path in (
            "/static/css/app.css",
            "/static/js/lib.js",
            "/static/js/app.js",
            "/static/js/staff.js",
        ):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()


if __name__ == "__main__":
    unittest.main()
