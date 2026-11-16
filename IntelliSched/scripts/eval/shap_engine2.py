"""SHAP explanation of IntelliSched's Engine 2 (faculty recommendation model).

Usage:
    pip install shap matplotlib pandas joblib      (into the project's Python environment)
    python shap_engine2.py --model <held-out model .joblib> --rows <feature rows .csv> --out docs/eval/phase10/figures

<feature rows .csv> has one row per (class, candidate professor) of the test term, with the
model's features as columns IN THE MODEL'S OWN ORDER (no other columns, no names, no ratings
shown anywhere). Writes:
    shap_bar_3x4.png, shap_bar_1x1.png   horizontal bar of mean |SHAP| per feature (main figure)
    shap_beeswarm_3x4.png                  per-row SHAP values (supplementary)
    shap_importance.csv                    mean |SHAP|, its share of the total, and the rank
Only feature totals are shown; no professor, class or individual rating appears.
"""
import argparse
import os

import joblib
import numpy as np
import pandas as pd

LABELS = {  # plain-English labels for the paper
    "semantic_match": "Credentials match (Engine 1)",
    "semesters_taught": "Semesters taught the subject",
    "sections_taught": "Sections taught the subject",
    "terms_since_last_taught": "Terms since last taught",
    "taught_it_last_same_semester": "Taught it last same semester",
    "eval_rating": "Student evaluation rating",
    "eval_missing": "No evaluation on record",
    "is_full_time": "Full-time faculty",
    "program_experience": "Experience in the program",
}


def unwrap(obj):
    if hasattr(obj, "predict_proba"):
        return obj
    if isinstance(obj, dict):
        for k in ("model", "estimator", "clf", "pipeline"):
            if k in obj and hasattr(obj[k], "predict_proba"):
                return obj[k]
    raise SystemExit("Could not find a model with predict_proba inside the joblib file.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--background", type=int, default=200)
    a = ap.parse_args()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import shap

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
    for f in ("Arial", "Liberation Sans"):
        from matplotlib import font_manager
        if any(f in x.name for x in font_manager.fontManager.ttflist):
            plt.rcParams["font.family"] = f
            break
    os.makedirs(a.out, exist_ok=True)
    model = unwrap(joblib.load(a.model))
    X = pd.read_csv(a.rows)
    n_in = getattr(model, "n_features_in_", X.shape[1])
    if X.shape[1] != n_in:
        raise SystemExit(f"The CSV has {X.shape[1]} columns but the model expects {n_in}.")
    names = list(getattr(model, "feature_names_in_", X.columns))
    if list(X.columns) != names:
        if set(X.columns) == set(names):
            X = X[names]
        else:
            print("Note: the model stores no feature names; using the CSV column order as given.")
    method = "TreeExplainer (exact for tree models; values in log-odds)"
    try:
        expl = shap.TreeExplainer(model)
        sv = expl(X)
        vals = sv.values
        if vals.ndim == 3:  # (rows, features, classes) -> positive class
            vals = vals[:, :, -1]
            sv = shap.Explanation(vals, base_values=np.asarray(sv.base_values)[..., -1], data=X.values, feature_names=list(X.columns))
    except Exception as e:  # fall back to the model-agnostic permutation explainer
        print(f"TreeExplainer not available ({e}); using the permutation explainer on predicted probability.")
        method = "Permutation explainer (model-agnostic; values in predicted probability)"
        bg = X.sample(min(a.background, len(X)), random_state=42)
        f = lambda d: model.predict_proba(pd.DataFrame(d, columns=X.columns))[:, 1]
        sv = shap.Explainer(f, bg, algorithm="permutation", seed=42)(X)
        vals = sv.values
    sv.feature_names = [LABELS.get(c, c) for c in X.columns]
    imp = pd.DataFrame({"feature": X.columns, "label": sv.feature_names, "mean_abs_shap": np.abs(vals).mean(axis=0)})
    imp["share_%"] = 100 * imp["mean_abs_shap"] / imp["mean_abs_shap"].sum()
    imp = imp.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)
    imp["rank"] = np.arange(1, len(imp) + 1)
    imp.to_csv(os.path.join(a.out, "shap_importance.csv"), index=False)

    unit = "log-odds" if "log-odds" in method else "probability"
    for tag, size in (("3x4", (6, 8)), ("1x1", (7, 7))):
        fig, ax = plt.subplots(figsize=size, dpi=300)
        d = imp.iloc[::-1]
        bars = ax.barh(d["label"], d["mean_abs_shap"], color="#1f6fb2")
        for b, v, s in zip(bars, d["mean_abs_shap"], d["share_%"]):
            ax.text(b.get_width(), b.get_y() + b.get_height() / 2, f"  {v:.3f} ({s:.0f}%)", va="center", fontsize=9)
        ax.set_xlabel(f"Mean |SHAP value|\n(average impact on the model output, {unit})")
        ax.set_title("SHAP feature importance\nFaculty recommendation model (Engine 2)", fontsize=12, pad=12)
        ax.spines[["top", "right"]].set_visible(False)
        ax.set_xlim(0, imp["mean_abs_shap"].max() * 1.35)
        fig.tight_layout()
        fig.savefig(os.path.join(a.out, f"shap_bar_{tag}.png"))
        plt.close(fig)
    plt.figure(figsize=(6, 8), dpi=300)
    shap.plots.beeswarm(sv, max_display=len(X.columns), show=False, plot_size=(6, 8))
    plt.title("SHAP values per candidate row\n(colour = feature value)", fontsize=11)
    plt.tight_layout()
    plt.savefig(os.path.join(a.out, "shap_beeswarm_3x4.png"), dpi=300)
    plt.close()
    with open(os.path.join(a.out, "shap_method.txt"), "w", encoding="utf-8") as fh:
        fh.write(f"Method: {method}\nRows explained: {len(X)}\nshap version: {shap.__version__}\n")
    print(imp.to_string(index=False))
    print("Method:", method)


if __name__ == "__main__":
    main()
