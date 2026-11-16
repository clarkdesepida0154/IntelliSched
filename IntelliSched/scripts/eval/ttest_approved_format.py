"""IntelliSched Phase 14 Part A: the Phase 10 paired t-tests in the approved study's format.

Usage (repo root, the Python service's own environment; no new package):
    ../intellisched_backend/.venv/Scripts/python scripts/eval/ttest_approved_format.py
    node scripts/eval/ttest_pdf.js          (prints the PDF from the HTML this script writes)

Reads exactly the Phase 10 files (docs/eval/phase10/schedule_units.csv, assignment_classes.csv,
assignment_faculty.csv) with the same pairing, units and IntelliSched values as
scripts/eval/analyze_phase10.py (for schedules, the mean of the 10 runs per unit), and writes into
docs/evaluation/ttest-approved-format/:
    ttest_tables.md, ttest_tables.json       a descriptive and a results table per comparison (A, B, C)
    fig_ttest_*_mean_median.png              mean = circle with its 95% CI, median = square (300 dpi)
    IntelliSched-Paired-TTest-Results.docx   A4, Arial 12, 1.5 lines, margins 1.5 in left / 1 in elsewhere
    source/ttest-results.html                the same content for the PDF (ttest_pdf.js)
The test is unchanged: paired-samples t-test, two-tailed, alpha = .05, Holm within the Phase 10
families, Cohen's d = mean difference / SD of the differences (Phase 10's d_z). Only the median and
the standard error of each group are new. Every t, df, p, Holm p and d is checked against
docs/eval/phase10/results.md to 3 decimals; the script stops (exit 2) when one differs.
No unit is named anywhere (the units are anonymous; nothing in the outputs carries a teacher's name).
"""
import json
import os
import re
import sys

import numpy as np
import pandas as pd
from scipy import stats

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(REPO, "docs", "eval", "phase10")
OUT = os.path.join(REPO, "docs", "evaluation", "ttest-approved-format")
ALPHA = 0.05
DPI = 300
IDENTICAL = "identical on every unit; the test cannot be computed (no variation in the differences)"
HA = "Hₐ: μ(Measure 1 − Measure 2) ≠ 0"
PAIRS = {"schedule": "Measure 1 − Measure 2 = Manual − IntelliSched", "assignment": "Measure 1 − Measure 2 = Manual − IntelliSched",
         "ranking": "Measure 1 − Measure 2 = Model − the simpler method (reciprocal rank of the Dean's actual choice)"}
FONT = "DejaVu Sans"
for f in ("Arial", "Liberation Sans"):
    if any(x.name == f for x in font_manager.fontManager.ttflist):
        FONT = f
        break
plt.rcParams.update({"font.family": FONT, "font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                     "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white"})
C1, C2 = "#555555", "#1f6fb2"


# ------------------------------------------------------------------------------------------ statistics
def group(x):
    x = np.asarray(x, float)
    n = len(x)
    sd = x.std(ddof=1)
    se = sd / np.sqrt(n)
    tc = stats.t.ppf(0.975, n - 1)
    return {"N": n, "Mean": x.mean(), "Median": float(np.median(x)), "SD": sd, "SE": se,
            "CI low": x.mean() - tc * se, "CI high": x.mean() + tc * se}


def paired(a, b, measure, family, better, names):
    """a = Measure 1 (Manual, or the model), b = Measure 2 (IntelliSched, or the simpler method)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    keep = ~(np.isnan(a) | np.isnan(b))
    a, b = a[keep], b[keep]
    d = a - b
    r = {"family": family, "measure": measure, "better": better, "group1": names[0], "group2": names[1],
         "g1": group(a), "g2": group(b), "n": len(a), "diff": d.mean(), "sd_diff": d.std(ddof=1),
         "t": None, "df": None, "p": None, "holm": None, "d": None, "note": ""}
    if np.isclose(r["sd_diff"], 0):
        r["note"] = IDENTICAL
        return r
    t, p = stats.ttest_rel(a, b)
    r.update(t=float(t), df=len(a) - 1, p=float(p), d=float(d.mean() / r["sd_diff"]))
    return r


def holm(rows):
    for fam in sorted({r["family"] for r in rows}):
        sub = sorted([r for r in rows if r["family"] == fam and r["p"] is not None], key=lambda r: r["p"])
        run = 0.0
        for k, r in enumerate(sub):
            run = max(run, min(1.0, (len(sub) - k) * r["p"]))
            r["holm"] = run


# ---------------------------------------------------------------------------------------- comparisons
QUALITY = [("Rule breaks", "lower"), ("Idle gap hours", "lower"), ("Single-class days", "lower"), ("Days used", "neutral")]
MAN_IS = ("Manual", "IntelliSched")


def schedule_rows():
    su = pd.read_csv(os.path.join(SRC, "schedule_units.csv"))
    su["Hard problems"] = su[["Conflicts", "Missing hours"]].fillna(0).sum(axis=1)
    rows = []
    for view, unit in (("Faculty", "teacher"), ("Section", "section"), ("Room", "room")):
        v = su[su.View == view]
        man = v[v.Source == "Manual"].groupby("Unit").mean(numeric_only=True)
        sysv = v[v.Source == "IntelliSched"].groupby("Unit").mean(numeric_only=True)  # mean of the runs per unit
        units = man.index.intersection(sysv.index)
        rows.append(paired(man.loc[units, "Hard problems"], sysv.loc[units, "Hard problems"],
                           f"{view}: hard problems per {unit}", "A1 primary", "lower", MAN_IS))
        for q, better in QUALITY:
            if q in v and v[q].notna().any():
                rows.append(paired(man.loc[units, q], sysv.loc[units, q], f"{view}: {q.lower()}", "A2 quality", better, MAN_IS))
    holm(rows)
    return rows, su[su.Source == "IntelliSched"]["Run"].nunique()


def assignment_rows():
    ac = pd.read_csv(os.path.join(SRC, "assignment_classes.csv"))
    af = pd.read_csv(os.path.join(SRC, "assignment_faculty.csv"))
    over = lambda col: (af[col] - af["Cap (h)"]).clip(lower=0)
    dev = lambda col: (af[col] - af.groupby("FT/PT")[col].transform("mean")).abs()
    rows = [
        paired(ac["Match manual"], ac["Match IntelliSched"], "Credentials match of the assigned teacher (per class)", "B1 primary", "higher", MAN_IS),
        paired(ac["Taught before manual"], ac["Taught before IntelliSched"], "Semesters the assigned teacher taught the subject before (per class)", "B1 primary", "higher", MAN_IS),
        paired(over("Load manual (h)"), over("Load IntelliSched (h)"), "Hours over the teaching cap (per teacher)", "B1 primary", "lower", MAN_IS),
        paired(af["Preparations manual"], af["Preparations IntelliSched"], "Different subjects to prepare (per teacher)", "B2 secondary", "lower", MAN_IS),
        paired(dev("Load manual (h)"), dev("Load IntelliSched (h)"), "Distance from the group's average load (per teacher; balance)", "B2 secondary", "lower", MAN_IS),
    ]
    holm(rows)
    rr = []
    for col, name, short in (("RR engine1", "Engine 1 only (credentials)", "Credentials only"),
                             ("RR rule", "Last same-semester teacher rule", "Last same-semester teacher rule"),
                             ("RR random", "Random choice", "Random choice")):
        r = paired(ac["RR model"], ac[col], f"Model vs {name} (reciprocal rank of the Dean's choice)", "B3 ranking", "higher", ("Model", short))
        r["short"] = short
        rr.append(r)
    holm(rr)
    return rows, rr


# ------------------------------------------------------------------------------------------ the check
def num(s):
    s = s.strip()
    if s in ("—", ""):
        return None
    if s.startswith("<"):
        return "<.001"
    return float(s)


def phase10_rows():
    out = {}
    for line in open(os.path.join(SRC, "results.md"), encoding="utf-8"):
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) == 13 and re.match(r"^(A1|A2|B1|B2|B3) ", c[0]):
            out[c[1]] = {"n": int(c[2]), "t": num(c[6]), "df": num(c[7]), "p": num(c[8]), "holm": num(c[9]), "d": num(c[10]),
                         "m1": c[3], "m2": c[4]}
    return out


def same(mine, theirs):
    if theirs is None:
        return mine is None
    if mine is None:
        return False
    if theirs == "<.001":
        return mine < 0.001
    return round(mine, 3) == round(theirs, 3) or abs(mine - theirs) < 0.0005 + 1e-12


def check(rows):
    ref = phase10_rows()
    problems, checked = [], 0
    for r in rows:
        p10 = ref.get(r["measure"])
        if p10 is None:
            problems.append(f"{r['measure']}: not found in results.md")
            continue
        for key in ("t", "df", "p", "holm", "d"):
            checked += 1
            if not same(r[key], p10[key]):
                problems.append(f"{r['measure']}: {key} = {r[key]} here, {p10[key]} in Phase 10")
        m1 = f"{r['g1']['Mean']:.3f} ({r['g1']['SD']:.3f})"
        m2 = f"{r['g2']['Mean']:.3f} ({r['g2']['SD']:.3f})"
        checked += 2
        if m1 != p10["m1"] or m2 != p10["m2"]:
            problems.append(f"{r['measure']}: group means/SDs differ from Phase 10")
        if r["n"] != p10["n"]:
            problems.append(f"{r['measure']}: n differs")
    missing = [k for k in ref if k not in {r["measure"] for r in rows}]
    problems += [f"{k}: in results.md but not recomputed" for k in missing]
    return {"tests": len(rows), "values_checked": checked, "differences": problems, "phase10_rows": len(ref)}


# -------------------------------------------------------------------------------------------- wording
def f3(x):
    return "—" if x is None else f"{x:.3f}"


def fp(p):
    return "—" if p is None else ("< .001" if p < 0.001 else f"{p:.3f}")


def apa_p(p):
    return "p < .001" if p < 0.001 else f"p = {p:.3f}".replace("0.", ".")


PHRASE = {
    "Credentials match of the assigned teacher (per class)": "the credentials match of the assigned teacher per class",
    "Semesters the assigned teacher taught the subject before (per class)": "the assigned teacher's earlier experience with the subject per class",
    "Hours over the teaching cap (per teacher)": "the hours over the teaching cap per teacher",
    "Different subjects to prepare (per teacher)": "the number of different subjects each teacher prepares",
    "Distance from the group's average load (per teacher; balance)": "each teacher's distance from the group's average load (load balance)",
}
BASELINE = {"Credentials only": "the credentials-only ranking", "Last same-semester teacher rule": "the last same-semester teacher rule",
            "Random choice": "a random choice"}


def topic(r):
    if r["measure"] in PHRASE:
        return PHRASE[r["measure"]]
    m = r["measure"]
    m = re.sub(r" \(reciprocal rank of the Dean's choice\)$", "", m)
    if ": " in m:
        view, what = m.split(": ", 1)
        unit = {"Faculty": "per teacher", "Section": "per section", "Room": "per room"}[view]
        what = re.sub(r" per (teacher|section|room)$", "", what)
        return f"{what} {unit}"
    return m[0].lower() + m[1:]


def interpret(r):
    a, b = r["group1"], r["group2"]
    if r["p"] is None:
        return (f"{a} and {b} have the same value on every unit for {topic(r)} "
                f"(mean {r['g1']['Mean']:.3f}), so the test cannot be computed; there is no difference.")
    stat = f"t({r['df']}) = {r['t']:.3f}, {apa_p(r['p'])}, Holm {apa_p(r['holm']).replace('p ', 'p ')}, d = {r['d']:.3f}"
    m1, m2 = r["g1"]["Mean"], r["g2"]["Mean"]
    if r["family"] == "B3 ranking":
        what = f"the reciprocal rank of the Dean's actual choice between the model ({m1:.3f}) and {BASELINE[b]} ({m2:.3f})"
        if r["holm"] >= ALPHA:
            return f"There is no statistically significant difference in {what}, {stat}."
        return (f"The model ranks the Dean's actual choice significantly higher than {BASELINE[b]} "
                f"({m1:.3f} vs {m2:.3f}), {stat}.")
    what = f"{topic(r)} between Manual ({m1:.3f}) and IntelliSched ({m2:.3f})"
    if r["holm"] >= ALPHA:
        extra = " (the unadjusted p is below .05, but not after the Holm correction)" if r["p"] < ALPHA else ""
        return f"There is no statistically significant difference in {what}, {stat}{extra}."
    if r["better"] == "neutral":
        more = "IntelliSched" if m2 > m1 else "Manual"
        return (f"There is a statistically significant difference in {what}, {stat}: {more} uses more days; "
                f"fewer or more days is not counted as better or worse.")
    better_is = (r["diff"] > 0) if r["better"] == "lower" else (r["diff"] < 0)
    who = "IntelliSched" if better_is else "Manual"
    word = "lower" if (r["diff"] > 0) == (who == "IntelliSched") else "higher"
    return (f"{who} is significantly better: the value is {word} with {who} for {topic(r)} "
            f"({m1:.3f} Manual vs {m2:.3f} IntelliSched), {stat}.")


# --------------------------------------------------------------------------------------------- figures
def figure(rows, path, ncols, label):
    tested = [r for r in rows if r["p"] is not None]
    n = len(tested)
    nrows = int(np.ceil(n / ncols))
    fig, axes = plt.subplots(nrows, ncols, figsize=(2.35 * ncols, 2.35 * nrows + 0.45), dpi=DPI, squeeze=False)
    for ax in axes.flat[n:]:
        ax.axis("off")
    for ax, r in zip(axes.flat, tested):
        for k, (g, col) in enumerate(((r["g1"], C1), (r["g2"], C2))):
            ax.errorbar(k, g["Mean"], yerr=[[g["Mean"] - g["CI low"]], [g["CI high"] - g["Mean"]]], fmt="o", color=col,
                        ms=6, capsize=4, lw=1.2, zorder=3)
            ax.plot(k + 0.16, g["Median"], "s", color=col, ms=5.5, mfc="white", mew=1.4, zorder=3)
        ax.set_xlim(-0.5, 1.66)
        ax.set_xticks([0.08, 1.08], [r["group1"], label(r)], fontsize=8)
        ax.set_title(panel_name(r), fontsize=8.5)
        ax.tick_params(axis="y", labelsize=7.5)
        ax.grid(axis="y", color="#e5e5e5", lw=0.6)
        ax.set_axisbelow(True)
    handles = [Line2D([], [], marker="o", color="#333333", lw=1.2, ms=6, label="Mean (95% CI)"),
               Line2D([], [], marker="s", color="#333333", lw=0, ms=5.5, mfc="white", mew=1.4, label="Median")]
    fig.legend(handles=handles, loc="lower center", ncol=2, frameon=False, fontsize=8.5)
    fig.tight_layout(rect=(0, 0.06 if nrows > 1 else 0.1, 1, 1))
    fig.savefig(path)
    plt.close(fig)


def panel_name(r):
    m = r["measure"]
    if r["family"] == "B3 ranking":
        return f"vs {r['short']}"
    m = re.sub(r" \((per class|per teacher|per teacher; balance)\)$", "", m)
    m = m.replace("Semesters the assigned teacher taught the subject before", "Taught the subject before")
    m = m.replace("Credentials match of the assigned teacher", "Credentials match")
    m = m.replace("Distance from the group's average load", "Distance from average load")
    m = m.replace("Different subjects to prepare", "Subjects to prepare")
    return m


# ------------------------------------------------------------------------------------------- documents
SECTIONS = [
    ("A", "schedule", "Schedule Generation", "schedule generation (per teacher, section and room)",
     "the Manual schedule and IntelliSched's schedule (the mean of its 10 runs per unit)"),
    ("B", "assignment", "Faculty Assignment", "faculty assignment", "the Manual assignment and IntelliSched's assignment"),
    ("C", "ranking", "Faculty Recommendation Ranking", "the faculty recommendation ranking",
     "the model's ranking and each simpler method's ranking of the Dean's actual choice"),
]


def desc_rows(rows):
    out = []
    for r in rows:
        for g, name in ((r["g1"], r["group1"]), (r["g2"], r["group2"])):
            out.append([r["measure"], name, str(g["N"]), f"{g['Mean']:.3f}", f"{g['Median']:.3f}", f"{g['SD']:.3f}", f"{g['SE']:.3f}"])
    return out


def ranking_desc(rows):
    """The model's group is the same in every ranking comparison: list it once."""
    g = rows[0]["g1"]
    out = [["Reciprocal rank of the Dean's choice", "Model", str(g["N"]), f"{g['Mean']:.3f}", f"{g['Median']:.3f}", f"{g['SD']:.3f}", f"{g['SE']:.3f}"]]
    for r in rows:
        h = r["g2"]
        out.append(["Reciprocal rank of the Dean's choice", r["group2"], str(h["N"]), f"{h['Mean']:.3f}", f"{h['Median']:.3f}", f"{h['SD']:.3f}", f"{h['SE']:.3f}"])
    return out


def res_rows(rows):
    out = []
    for r in rows:
        label = f"Model − {r['group2']}" if r["family"] == "B3 ranking" else r["measure"]
        out.append([label, "Student's t", f3(r["t"]), "—" if r["df"] is None else str(r["df"]), fp(r["p"]), fp(r["holm"]),
                    f"{r['diff']:.3f}", f3(r["d"])])
    return out


DESC_HEAD = ["Measure", "Group", "N", "Mean", "Median", "SD", "SE"]
RES_HEAD = ["Measure", "T-Test", "Statistic", "df", "p", "Holm p", "Mean Difference", "Effect Size (Cohen's d)"]


def md_table(head, body):
    lines = ["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |"]
    lines += ["| " + " | ".join(row) + " |" for row in body]
    return lines


def main():
    os.makedirs(os.path.join(OUT, "source"), exist_ok=True)
    sched, runs = schedule_rows()
    assign, rank = assignment_rows()
    result = check(sched + assign + rank)
    if result["differences"]:
        print("STOP: the recomputed tests differ from Phase 10 results.md:")
        for p in result["differences"]:
            print("  " + p)
        sys.exit(2)
    print(f"Check: {result['tests']} tests, {result['values_checked']} values equal Phase 10 results.md to 3 decimals.")
    groups = {"schedule": sched, "assignment": assign, "ranking": rank}

    # figures
    figure(sched, os.path.join(OUT, "fig_ttest_schedule_mean_median.png"), 3, lambda r: "IntelliSched")
    figure(assign, os.path.join(OUT, "fig_ttest_assignment_mean_median.png"), 2, lambda r: "IntelliSched")
    figure(rank, os.path.join(OUT, "fig_ttest_ranking_mean_median.png"), 3,
           lambda r: {"Credentials only": "Credentials\nonly", "Last same-semester teacher rule": "Same-semester\nrule",
                      "Random choice": "Random"}[r["short"]])

    # markdown
    md = ["# Paired t-tests in the approved format (Phase 10 data, 2nd Sem AY 2025-26)", "",
          "Paired-samples t-test, two-tailed, α = .05; significance decided by the Holm-adjusted p within the Phase 10 families "
          "(A1, A2, B1, B2, B3); Cohen's d = mean difference ÷ SD of the differences (Phase 10's d_z). "
          f"Measure 1 − Measure 2 = Manual − IntelliSched (Model − simpler method for C). IntelliSched's schedule values are the mean of its {runs} runs per unit. "
          "SE = SD ÷ √N. Units are anonymous; no teacher, section or room is named.", "",
          f"Check: every t, df, p, Holm p and d equals docs/eval/phase10/results.md to 3 decimals ({result['tests']} tests, {result['values_checked']} values).", ""]
    tno, fno = 1, 1
    js = {"method": {"test": "paired-samples t-test", "tails": 2, "alpha": ALPHA, "correction": "Holm within the Phase 10 families",
                     "effect_size": "Cohen's d = mean difference / SD of the differences", "source": "docs/eval/phase10/*.csv",
                     "intellisched_schedule_runs_per_unit": int(runs), "alternative": HA},
          "check_against_phase10": result, "comparisons": []}
    for letter, key, title, what, pair in SECTIONS:
        rows = groups[key]
        d = ranking_desc(rows) if key == "ranking" else desc_rows(rows)
        md += [f"## {letter}. {title}", "", f"**Table {tno}. Descriptive Comparison of {title}**", ""] + md_table(DESC_HEAD, d) + [""]
        md += [f"**Table {tno + 1}. Results of the Paired Samples T-Test on {title}**", ""]
        md += md_table(RES_HEAD + ["Interpretation"], [row + [interpret(r)] for row, r in zip(res_rows(rows), rows)])
        md += ["", f"Note. {HA}; {PAIRS[key]}. A dash (—): {IDENTICAL}.", "",
               f"**Figure {fno}. Mean and Median of {title}** (fig_ttest_{key}_mean_median.png): each group's mean as a circle with its 95% CI, the median as a square.", ""]
        js["comparisons"].append({"part": letter, "name": title, "figure": f"fig_ttest_{key}_mean_median.png",
                                  "tests": [{k: v for k, v in r.items() if k not in ("better",)} | {"interpretation": interpret(r)} for r in rows]})
        tno += 2
        fno += 1
    with open(os.path.join(OUT, "ttest_tables.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(OUT, "ttest_tables.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(js, f, indent=2, ensure_ascii=False, default=lambda o: float(o) if isinstance(o, (np.floating,)) else int(o))
        f.write("\n")

    doc = document(groups, runs)
    write_html(doc)
    write_docx(doc)
    print("Wrote", os.path.relpath(OUT, REPO))


# ------------------------------------------------------------------- one content model for HTML and DOCX
def short_stat(r):
    return f"t({r['df']}) = {r['t']:.3f}, Holm {apa_p(r['holm'])}, d = {r['d']:.3f}"


def summary_par(letter, key, title, what, pair, rows):
    tested = [r for r in rows if r["p"] is not None]
    sig = [r for r in tested if r["holm"] < ALPHA]
    ident = [r for r in rows if r["p"] is None]
    s = [f"For {what}, {len(rows)} paired comparisons were made between {pair}."]
    if ident:
        s.append(f"{len(ident)} {'is' if len(ident) == 1 else 'are'} identical on every unit ({', '.join(topic(r) for r in ident)}), "
                 "so no test can be computed and there is no difference.")
    parts = []
    for r in sig:
        if key == "ranking":
            parts.append(f"the model ranks the Dean's actual choice higher than {BASELINE[r['group2']]} ({short_stat(r)})")
        elif r["better"] == "neutral":
            more = "IntelliSched" if r["g2"]["Mean"] > r["g1"]["Mean"] else "Manual"
            parts.append(f"{topic(r)} differs, with {more} using more days, which is not counted as better or worse ({short_stat(r)})")
        else:
            good = (r["diff"] > 0) if r["better"] == "lower" else (r["diff"] < 0)
            parts.append(f"{'IntelliSched' if good else 'Manual'} is better in {topic(r)} ({short_stat(r)})")
    if sig:
        s.append(f"After the Holm correction, {len(sig)} of the {len(tested)} computed differences {'is' if len(sig) == 1 else 'are'} "
                 "statistically significant: " + "; ".join(parts) + ".")
    else:
        s.append("After the Holm correction, none of the differences is statistically significant.")
    rest = [r for r in tested if r["holm"] >= ALPHA]
    if rest:
        who = (", ".join(f"{BASELINE[r['group2']]}" for r in rest) if key == "ranking" else ", ".join(topic(r) for r in rest))
        s.append(("There is no statistically significant difference between the model and " if key == "ranking"
                  else "There is no statistically significant difference in ") + who + ".")
    return " ".join(s)


def document(groups, runs):
    items = [("title", "IntelliSched: Results of the Paired Samples T-Tests"),
             ("sub", "Manual scheduling vs IntelliSched, 2nd Semester AY 2025-2026"),
             ("p", "The same Phase 10 data were analysed again without collecting anything new. Each comparison is a paired-samples "
                   "t-test (two-tailed, α = .05) on the same units: each teacher, section and room for the schedule "
                   f"(IntelliSched's value per unit is the mean of its {runs} runs, with the Dean's teacher assignments kept), each class "
                   "and each teacher for the faculty assignment, and each class for the ranking of the Dean's actual choice. Because several "
                   "measures are tested together, significance is decided by the Holm-adjusted p within each family of tests. The effect "
                   "size is Cohen's d for paired samples (the mean difference divided by the standard deviation of the differences). "
                   "Each group's median and standard error (SE = SD ÷ √N) are reported with its mean and standard deviation. "
                   "Measure 1 − Measure 2 is Manual − IntelliSched, or Model − simpler method for the ranking; the alternative hypothesis "
                   f"is {HA}. Where both groups have the same value on every unit, no test can be computed and the table shows a dash.")]
    tno, fno = 1, 1
    for letter, key, title, what, pair in SECTIONS:
        rows = groups[key]
        items.append(("h", f"{letter}. {title}"))
        items.append(("cap", f"Table {tno}. Descriptive Comparison of {title}"))
        items.append(("table", DESC_HEAD, ranking_desc(rows) if key == "ranking" else desc_rows(rows), None))
        items.append(("cap", f"Table {tno + 1}. Results of the Paired Samples T-Test on {title}"))
        items.append(("table", RES_HEAD, res_rows(rows), f"Note. {HA}; {PAIRS[key]}. A dash (—): {IDENTICAL}."))
        items.append(("img", f"fig_ttest_{key}_mean_median.png", f"Figure {fno}. Mean and Median of {title}. "
                      "Circles are means with their 95% confidence intervals; squares are medians."))
        items.append(("p", summary_par(letter, key, title, what, pair, rows)))
        tno += 2
        fno += 1
    return items


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_html(items):
    css = """@page { size: A4; margin: 1in 1in 1in 1.5in; }
body { font-family: Arial, Arimo, sans-serif; font-size: 12pt; line-height: 1.5; color: #000; background: #fff; margin: 0; }
h1 { font-size: 14pt; text-align: center; margin: 0 0 0 0; } .sub { text-align: center; margin: 0 0 12pt; }
h2 { font-size: 12pt; margin: 18pt 0 6pt; break-after: avoid; } p { text-align: justify; margin: 0 0 12pt; }
.cap { font-weight: bold; margin: 12pt 0 4pt; break-after: avoid; text-align: left; }
.figcap { margin: 4pt 0 12pt; text-align: left; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; line-height: 1.2; margin: 0 0 4pt; break-inside: avoid; }
td:first-child { width: 38%; } td:not(:first-child) { white-space: nowrap; }
th, td { border-top: 0.75pt solid #000; border-bottom: 0.75pt solid #000; padding: 3pt 4pt; text-align: center; vertical-align: top; }
th { font-weight: bold; } td:first-child, th:first-child { text-align: left; }
.note { font-size: 10pt; line-height: 1.2; margin: 0 0 12pt; } figure { margin: 6pt 0 0; break-inside: avoid; } img { width: 100%; }"""
    h = ["<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>IntelliSched Paired T-Test Results</title>",
         f"<style>{css}</style></head><body>"]
    for it in items:
        k = it[0]
        if k == "title":
            h.append(f"<h1>{esc(it[1])}</h1>")
        elif k == "sub":
            h.append(f"<p class=\"sub\">{esc(it[1])}</p>")
        elif k == "h":
            h.append(f"<h2>{esc(it[1])}</h2>")
        elif k == "p":
            h.append(f"<p>{esc(it[1])}</p>")
        elif k == "cap":
            h.append(f"<p class=\"cap\">{esc(it[1])}</p>")
        elif k == "table":
            _, head, body, note = it
            h.append("<table><thead><tr>" + "".join(f"<th>{esc(c)}</th>" for c in head) + "</tr></thead><tbody>")
            h += ["<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in body]
            h.append("</tbody></table>")
            if note:
                h.append(f"<p class=\"note\">{esc(note)}</p>")
        elif k == "img":
            h.append(f"<figure><img src=\"../{it[1]}\" alt=\"{esc(it[2])}\"><p class=\"figcap\">{esc(it[2])}</p></figure>")
    h.append("</body></html>")
    with open(os.path.join(OUT, "source", "ttest-results.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(h) + "\n")


def write_docx(items):
    from docx import Document
    from docx.enum.section import WD_ORIENT  # noqa: F401
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Mm, Pt

    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin, sec.right_margin, sec.top_margin, sec.bottom_margin = Inches(1.5), Inches(1), Inches(1), Inches(1)
    st = doc.styles["Normal"]
    st.font.name, st.font.size = "Arial", Pt(12)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Arial")
    st.paragraph_format.line_spacing = 1.5
    st.paragraph_format.space_after = Pt(12)
    width = Mm(210) - Inches(2.5)

    def par(text, bold=False, align=None, size=None, after=None, keep=False, spacing=None):
        p = doc.add_paragraph()
        run = p.add_run(text)
        run.bold = bold
        if size:
            run.font.size = Pt(size)
        if align is not None:
            p.alignment = align
        if after is not None:
            p.paragraph_format.space_after = Pt(after)
        if spacing is not None:
            p.paragraph_format.line_spacing = spacing
        p.paragraph_format.keep_with_next = keep
        return p

    def borders(cell, top=True, bottom=True):
        tcPr = cell._tc.get_or_add_tcPr()
        b = OxmlElement("w:tcBorders")
        for edge, on in (("top", top), ("bottom", bottom), ("left", False), ("right", False)):
            e = OxmlElement(f"w:{edge}")
            e.set(qn("w:val"), "single" if on else "nil")
            if on:
                e.set(qn("w:sz"), "6")
                e.set(qn("w:color"), "000000")
            b.append(e)
        tcPr.append(b)

    for it in items:
        k = it[0]
        if k == "title":
            par(it[1], bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, size=14, after=0)
        elif k == "sub":
            par(it[1], align=WD_ALIGN_PARAGRAPH.CENTER)
        elif k == "h":
            p = par(it[1], bold=True, keep=True, after=6)
            p.paragraph_format.space_before = Pt(12)
        elif k == "p":
            par(it[1], align=WD_ALIGN_PARAGRAPH.JUSTIFY)
        elif k == "cap":
            par(it[1], bold=True, keep=True, after=4)
        elif k == "table":
            _, head, body, note = it
            t = doc.add_table(rows=1 + len(body), cols=len(head))
            t.alignment = WD_TABLE_ALIGNMENT.CENTER
            t.autofit = False
            shares = ([0.21, 0.13, 0.12, 0.05, 0.09, 0.09, 0.14, 0.17] if len(head) == 8
                      else [0.34, 0.18, 0.06, 0.105, 0.11, 0.1, 0.105])
            widths = [int(width * f) for f in shares]
            tblPr = t._tbl.tblPr
            mar = OxmlElement("w:tblCellMar")
            for edge in ("left", "right"):
                e = OxmlElement(f"w:{edge}")
                e.set(qn("w:w"), "57")
                e.set(qn("w:type"), "dxa")
                mar.append(e)
            tblPr.append(mar)
            lay = OxmlElement("w:tblLayout")
            lay.set(qn("w:type"), "fixed")
            tblPr.append(lay)
            grid = t._tbl.tblGrid
            for gc, w in zip(grid.findall(qn("w:gridCol")), widths):
                gc.set(qn("w:w"), str(int(w / 635)))
            for ri, row in enumerate([head] + body):
                for ci, val in enumerate(row):
                    cell = t.cell(ri, ci)
                    cell.text = ""
                    p = cell.paragraphs[0]
                    r = p.add_run(val.replace("< .", "<" + chr(160) + "."))
                    r.font.size = Pt(10)
                    r.bold = ri == 0
                    p.paragraph_format.line_spacing = 1.0
                    p.paragraph_format.space_after = Pt(0)
                    p.paragraph_format.keep_with_next = ri == 0
                    cell.width = widths[ci]
                    p.alignment = WD_ALIGN_PARAGRAPH.LEFT if ci == 0 else WD_ALIGN_PARAGRAPH.CENTER
                    borders(cell, top=ri <= 1, bottom=ri == 0 or ri == len(body))
                cs = OxmlElement("w:cantSplit")
                t.rows[ri]._tr.get_or_add_trPr().append(cs)
                if ri == 0:
                    trPr = t.rows[0]._tr.get_or_add_trPr()
                    th = OxmlElement("w:tblHeader")
                    th.set(qn("w:val"), "true")
                    trPr.append(th)
            if note:
                p = par(note, size=10, spacing=1.0)
                p.paragraph_format.space_before = Pt(4)
            else:
                par("", after=0, spacing=1.0)
        elif k == "img":
            p = doc.add_paragraph()
            p.paragraph_format.keep_with_next = True
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = 1.0
            p.add_run().add_picture(os.path.join(OUT, it[1]), width=width)
            par(it[2])
    doc.core_properties.title = "IntelliSched: Results of the Paired Samples T-Tests"
    doc.core_properties.author = "The IntelliSched team"
    doc.save(os.path.join(OUT, "IntelliSched-Paired-TTest-Results.docx"))


if __name__ == "__main__":
    main()
