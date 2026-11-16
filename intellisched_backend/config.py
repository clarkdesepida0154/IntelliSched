import os
from pathlib import Path
from dotenv import load_dotenv

from database import assert_database_allowed, database_name

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

MONGO_URI = os.getenv("MONGO_URI")

if not MONGO_URI:
    raise RuntimeError("CRITICAL: MONGO_URI environment variable is not set. Refusing to start the server.")

# The service refuses to start against the live database unless ALLOW_LIVE_DB=1.
MONGO_DB_NAME = database_name(MONGO_URI)
assert_database_allowed(MONGO_DB_NAME)

# ML_MODEL_PATH (Phase 8 Part 11): another copy of the model, so a retraining on a demo database never
# replaces the file committed here (the demos pass their own copy under IntelliSched/.demo-data/models/).
MODEL_PATH = Path(os.getenv("ML_MODEL_PATH") or BASE_DIR / "intellisched_gbdt_engine.joblib")
# Phase 8 Part 11: the past semesters' ranking questions Engine 4 refits on (ml/build_dataset.py writes
# it; it holds ratings, so it stays in the IntelliSched repo's gitignored docs/ml/private/). ML_DATASET
# overrides the path.
ML_DATASET_PATH = Path(os.getenv("ML_DATASET") or BASE_DIR.parent / "IntelliSched" / "docs" / "ml" / "private" / "dataset_full.csv")

# Phase 5: the ranking's features, defined once in ml/features.py (the dataset builder, Engine 2 and
# Engine 4 all read that list).
from ml.features import FEATURES as GBDT_FEATURES  # noqa: E402
