"""IntelliSched Phase 10: manual (Dean + College Secretary) vs IntelliSched, 2nd Sem AY 2025-26.

Usage:
    pip install pandas scipy matplotlib
    python analyze_phase10.py docs/eval/phase10

Reads the CSVs that Phase 10 writes into that folder (formats below) and writes
results.md plus figures/*.png (300 dpi).  Nothing is estimated: a missing file or a test
that cannot be computed is reported as such.

Pre-registered decisions (fixed before any result):
  * Paired t-test, two-tailed, alpha = .05; 95% CI of the mean difference; Cohen's d_z;
    Shapiro-Wilk on the differences and the Wilcoxon signed-rank test as confirmation.
  * Holm-Bonferroni inside each family of tests (each "Family" column in the tables).
  * Schedule, primary outcome per unit: hard problems = conflicts + missing hours (overload belongs to part B).
    IntelliSched's value per unit = the mean over its runs (so no single lucky run decides).
  * Faculty assignment, primary outcomes: credentials match and prior experience per class,
    hours over the teaching cap per teacher.
  * "Days used" is reported but not called better or worse (no agreed direction).

CSV formats (columns, in this order; blank = not applicable):
  schedule_units.csv     View, Unit, Source, Run, Conflicts, Overload, Missing hours, Rule breaks,
                         Idle gap hours, Days used, Single-class days, Used hours
                         Source = Manual | IntelliSched | Pipeline ; Run = 0 for Manual
  meetings.csv           Source, Run, Professor, Subject, Section, Type, Day, Start, End, Room, Week group
                         (Manual and the ONE pre-chosen IntelliSched run; Day = Mon..Sat; HH:MM; Week group = All|Odd|Even)
  assignment_classes.csv Class, Subject, Section, Manual teacher, IntelliSched teacher, Candidates,
                         Match manual, Match IntelliSched, Taught before manual, Taught before IntelliSched,
                         RR model, RR engine1, RR rule, RR random
  assignment_faculty.csv Teacher, FT/PT, Cap (h), Load manual (h), Load IntelliSched (h),
                         Preparations manual, Preparations IntelliSched
  ga_runs_ui.csv         Assignment, Run, Seed, Conflicts on screen, Validator conflicts, Checker conflicts,
                         Soft S, Time to result (s), Approve enabled, Exports ok
  fault_injection.csv    Case, Fault type, Should be flagged, Validator flagged, Checker flagged,
                         UI flagged, Approve blocked, Rule code, Base seed
"""
import os
import sys

import numpy as np
import pandas as pd
from scipy import stats

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

ALPHA = 0.05
C_MAN, C_IS, C_PIPE = "#8c8c8c", "#1f6fb2", "#2a9d8f"
DPI = 300
for f in ("Arial", "Liberation Sans", "DejaVu Sans"):
    if any(f in x.name for x in font_manager.fontManager.ttflist):
        plt.rcParams["font.family"] = f
        break
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})


def fp(p):
    return "—" if p is None or (isinstance(p, float) and np.isnan(p)) else ("< .001" if p < 0.001 else f"{p:.3f}")


def wilson(k, n, z=1.96):
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def holm(ps):
    idx = [i for i, p in enumerate(ps) if p is not None and not np.isnan(p)]
    out = [None] * len(ps)
    order = sorted(idx, key=lambda i: ps[i])
    run = 0.0
    for r, i in enumerate(order):
        run = max(run, min(1.0, (len(order) - r) * ps[i]))
        out[i] = run
    return out


def paired(a, b, label, family, better="lower"):
    """a = manual, b = IntelliSched (same units, same order). d = a - b."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = ~(np.isnan(a) | np.isnan(b))
    a, b = a[m], b[m]
    n = len(a)
    r = {"Family": family, "Measure": label, "n": n, "Manual mean": a.mean() if n else np.nan,
         "Manual SD": a.std(ddof=1) if n > 1 else np.nan, "IntelliSched mean": b.mean() if n else np.nan,
         "IntelliSched SD": b.std(ddof=1) if n > 1 else np.nan, "better": better,
         "diff": np.nan, "lo": np.nan, "hi": np.nan, "t": np.nan, "p": np.nan, "dz": np.nan,
         "W p": np.nan, "SW p": np.nan, "note": ""}
    if n < 2:
        r["note"] = "fewer than 2 units"
        return r
    d = a - b
    r["diff"] = d.mean()
    sd = d.std(ddof=1)
    if np.isclose(sd, 0):
        r["note"] = ("both schedules identical on every unit" if np.isclose(d.mean(), 0)
                     else f"every difference equals {d.mean():g}; t undefined")
        return r
    t, p = stats.ttest_rel(a, b)
    tc = stats.t.ppf(0.975, n - 1)
    r.update(t=t, p=p, dz=d.mean() / sd, lo=d.mean() - tc * sd / np.sqrt(n), hi=d.mean() + tc * sd / np.sqrt(n))
    if n >= 3:
        r["SW p"] = stats.shapiro(d).pvalue
    if (d != 0).any():
        r["W p"] = stats.wilcoxon(a, b).pvalue
    return r


def verdict(r):
    if r.get("holm") is None or np.isnan(r["diff"]):
        return r["note"] or "not tested"
    if r["holm"] >= ALPHA:
        return "no significant difference"
    if r["better"] == "neutral":
        return "significant difference"
    if r["better"] == "lower":
        return "IntelliSched significantly better" if r["diff"] > 0 else "Manual significantly better"
    return "IntelliSched significantly better" if r["diff"] < 0 else "Manual significantly better"


def table(rows, md):
    md += ["| Family | Measure | n | Manual mean (SD) | IntelliSched mean (SD) | Difference M − I [95% CI] | t | df | p | Holm p | d_z | Wilcoxon p | Result |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        ci = "—" if np.isnan(r["lo"]) else f"{r['diff']:.3f} [{r['lo']:.3f}, {r['hi']:.3f}]"
        if np.isnan(r["lo"]) and not np.isnan(r["diff"]):
            ci = f"{r['diff']:.3f}"
        tt = "—" if np.isnan(r["t"]) else f"{r['t']:.3f}"
        df_ = "—" if np.isnan(r["t"]) else str(r["n"] - 1)
        dz = "—" if np.isnan(r["dz"]) else f"{r['dz']:.3f}"
        md.append(f"| {r['Family']} | {r['Measure']} | {r['n']} | {r['Manual mean']:.3f} ({r['Manual SD']:.3f}) | "
                  f"{r['IntelliSched mean']:.3f} ({r['IntelliSched SD']:.3f}) | {ci} | "
                  f"{tt} | {df_} | {fp(r['p'])} | {fp(r.get('holm'))} | {dz} | {fp(r['W p'])} | {verdict(r)} |")
    md.append("")


def apply_holm(rows):
    for fam in {r["Family"] for r in rows}:
        sub = [r for r in rows if r["Family"] == fam]
        for r, h in zip(sub, holm([r["p"] for r in sub])):
            r["holm"] = h


def load(folder, name):
    f = os.path.join(folder, name)
    return pd.read_csv(f) if os.path.exists(f) else None


# ---------------------------------------------------------------- schedule
PRIMARY = ["Conflicts", "Missing hours"]  # overload depends on the teacher assignment, which is locked here: it is tested in part B
QUALITY = [("Rule breaks", "lower"), ("Idle gap hours", "lower"), ("Single-class days", "lower"), ("Days used", "neutral")]


def schedule(folder, figs, md, summary):
    su = load(folder, "schedule_units.csv")
    if su is None:
        md += ["## A. Schedule generation", "", "schedule_units.csv not found.", ""]
        return
    su["Hard problems"] = su[PRIMARY].fillna(0).sum(axis=1)
    md += ["## A. Schedule generation: manual vs IntelliSched", ""]
    runs = su[su.Source == "IntelliSched"]["Run"].nunique()
    md += [f"IntelliSched values are the mean over {runs} runs per unit (Dean's teacher assignments locked, so only day, time and room differ).", ""]
    rows, plot = [], {}
    for comp, fam_p, fam_q in (("IntelliSched", "A1 primary", "A2 quality"), ("Pipeline", "A3 full pipeline", "A3 full pipeline")):
        if comp not in set(su.Source):
            continue
        for view in ["Faculty", "Section", "Room"]:
            v = su[su.View == view]
            man = v[v.Source == "Manual"].groupby("Unit").mean(numeric_only=True)
            sysv = v[v.Source == comp].groupby("Unit").mean(numeric_only=True)
            units = man.index.intersection(sysv.index)
            if not len(units):
                continue
            r = paired(man.loc[units, "Hard problems"], sysv.loc[units, "Hard problems"], f"{view}: hard problems per {view.lower() if view!='Faculty' else 'teacher'}", fam_p)
            rows.append(r)
            if comp == "IntelliSched":
                plot[view] = (man.loc[units, "Hard problems"], sysv.loc[units, "Hard problems"])
            if comp == "IntelliSched":
                for q, better in QUALITY:
                    if q in v and v[q].notna().any():
                        rows.append(paired(man.loc[units, q], sysv.loc[units, q], f"{view}: {q.lower()}", fam_q, better))
    apply_holm(rows)
    table(rows, md)
    summary["schedule"] = rows
    md += ["Item totals (Manual = one schedule; IntelliSched = mean per run):", "", "| View | Measure | Manual total | IntelliSched total per run |", "| --- | --- | --- | --- |"]
    for view in ["Faculty", "Section", "Room"]:
        v = su[su.View == view]
        for c in PRIMARY + [q for q, _ in QUALITY]:
            if c in v and v[c].notna().any():
                mt = v[v.Source == "Manual"][c].sum()
                it = v[v.Source == "IntelliSched"].groupby("Run")[c].sum().mean() if (v.Source == "IntelliSched").any() else np.nan
                md.append(f"| {view} | {c} | {mt:g} | {it:.2f} |")
    md.append("")
    if plot:
        fig, axes = plt.subplots(1, 2, figsize=(10, 4.2), dpi=DPI, gridspec_kw={"width_ratios": [1, 1.6]})
        ax = axes[0]
        views = list(plot)
        x = np.arange(len(views))
        for k, (lab, col, off) in enumerate((("Manual (Dean & Secretary)", C_MAN, -0.18), ("IntelliSched", C_IS, 0.18))):
            means, errs = [], []
            for vw in views:
                d = np.asarray(plot[vw][k], float)
                means.append(d.mean())
                errs.append(stats.t.ppf(0.975, len(d) - 1) * d.std(ddof=1) / np.sqrt(len(d)) if len(d) > 1 else 0)
            ax.bar(x + off, means, 0.36, yerr=errs, capsize=4, color=col, label=lab)
            for xi, mval in zip(x + off, means):
                ax.text(xi, mval, f"{mval:.2f}", ha="center", va="bottom", fontsize=8)
        ax.set_xticks(x, [f"Per {vw.lower() if vw!='Faculty' else 'teacher'}" for vw in views])
        ax.set_ylabel("Hard problems per unit (mean, 95% CI)")
        ax.set_title("Conflicts and missing hours")
        ax.legend(frameon=False, fontsize=8)
        ax = axes[1]
        pos = 0
        ticks, labs = [], []
        for vw in views:
            a, b = np.asarray(plot[vw][0], float), np.asarray(plot[vw][1], float)
            for ai, bi in zip(a, b):
                ax.plot([pos, pos + 1], [ai, bi], color="#c9c9c9", lw=0.8, zorder=1)
            ax.scatter(np.full(len(a), pos), a, color=C_MAN, s=14, zorder=2)
            ax.scatter(np.full(len(b), pos + 1), b, color=C_IS, s=14, zorder=2)
            ticks += [pos, pos + 1]
            labs += [f"{vw}\nManual", f"{vw}\nIntelliSched"]
            pos += 3
        ax.set_xticks(ticks, labs, fontsize=8)
        ax.set_ylabel("Hard problems (each line = one unit)")
        ax.set_title("Same unit, manual vs IntelliSched")
        fig.tight_layout()
        fig.savefig(os.path.join(figs, "fig_A1_schedule_hard_problems.png"))
        plt.close(fig)
    qs = [q for q, _ in QUALITY if q in su and su[su.View.isin(["Faculty", "Section"])][q].notna().any()]
    if qs:
        fig, axes = plt.subplots(1, len(qs), figsize=(2.6 * len(qs), 3.6), dpi=DPI)
        axes = np.atleast_1d(axes)
        for ax, q in zip(axes, qs):
            vals = []
            for vw in ["Faculty", "Section"]:
                v = su[su.View == vw]
                if not v[q].notna().any():
                    continue
                man = v[v.Source == "Manual"].groupby("Unit")[q].mean()
                sysv = v[v.Source == "IntelliSched"].groupby("Unit")[q].mean()
                vals.append((vw, man.mean(), sysv.mean()))
            x = np.arange(len(vals))
            ax.bar(x - 0.18, [v[1] for v in vals], 0.36, color=C_MAN, label="Manual")
            ax.bar(x + 0.18, [v[2] for v in vals], 0.36, color=C_IS, label="IntelliSched")
            ax.set_xticks(x, [v[0] for v in vals])
            ax.set_title(q, fontsize=10)
        axes[0].legend(frameon=False, fontsize=8)
        fig.suptitle("Schedule quality per unit (mean)", fontsize=11)
        fig.tight_layout()
        fig.savefig(os.path.join(figs, "fig_A2_schedule_quality.png"))
        plt.close(fig)


def room_heatmap(folder, figs, md):
    me = load(folder, "meetings.csv")
    if me is None or me.empty:
        return
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    slots = [7 * 60 + 30 * i for i in range(22)]  # 7:00 .. 17:30

    def mins(s):
        h, m = str(s).split(":")[:2]
        return int(h) * 60 + int(m)
    srcs = [s for s in ["Manual", "IntelliSched"] if s in set(me.Source)]
    fig, axes = plt.subplots(1, len(srcs), figsize=(5.2 * len(srcs), 4.6), dpi=DPI, sharey=True)
    axes = np.atleast_1d(axes)
    vmax = 0
    grids = []
    for s in srcs:
        g = np.zeros((len(slots), len(days)))
        sub = me[(me.Source == s) & me.Room.notna() & (me.Room.astype(str).str.upper() != "TBA")]
        for _, r in sub.iterrows():
            if r.Day not in days:
                continue
            w = 0.5 if str(r["Week group"]).lower() in ("odd", "even") else 1.0
            a, b = mins(r.Start), mins(r.End)
            for i, sl in enumerate(slots):
                if a <= sl < b:
                    g[i, days.index(r.Day)] += w
        grids.append(g)
        vmax = max(vmax, g.max())
    for ax, s, g in zip(axes, srcs, grids):
        im = ax.imshow(g, aspect="auto", cmap="Blues", vmin=0, vmax=vmax)
        ax.set_xticks(range(len(days)), days)
        ax.set_yticks(range(0, len(slots), 2), [f"{sl//60}:{sl%60:02d}" for sl in slots[::2]])
        ax.set_title(f"{s}: rooms in use", fontsize=10)
    fig.colorbar(im, ax=list(axes), shrink=0.8, label="Rooms occupied (odd/even-week meetings count 0.5)")
    fig.savefig(os.path.join(figs, "fig_A3_room_use_heatmap.png"), bbox_inches="tight")
    plt.close(fig)
    md += ["Room-use heatmap: figures/fig_A3_room_use_heatmap.png (Manual vs the pre-chosen IntelliSched run).", ""]


# ---------------------------------------------------------------- faculty assignment
def assignment(folder, figs, md, summary):
    ac, af = load(folder, "assignment_classes.csv"), load(folder, "assignment_faculty.csv")
    md += ["## B. Faculty assignment: manual vs IntelliSched", ""]
    if ac is None:
        md += ["assignment_classes.csv not found.", ""]
        return
    rows = [paired(ac["Match manual"], ac["Match IntelliSched"], "Credentials match of the assigned teacher (per class)", "B1 primary", "higher"),
            paired(ac["Taught before manual"], ac["Taught before IntelliSched"], "Semesters the assigned teacher taught the subject before (per class)", "B1 primary", "higher")]
    if af is not None:
        over_m = (af["Load manual (h)"] - af["Cap (h)"]).clip(lower=0)
        over_i = (af["Load IntelliSched (h)"] - af["Cap (h)"]).clip(lower=0)
        rows.append(paired(over_m, over_i, "Hours over the teaching cap (per teacher)", "B1 primary", "lower"))
        rows.append(paired(af["Preparations manual"], af["Preparations IntelliSched"], "Different subjects to prepare (per teacher)", "B2 secondary", "lower"))
        dev = lambda col: (af[col] - af.groupby("FT/PT")[col].transform("mean")).abs()
        rows.append(paired(dev("Load manual (h)"), dev("Load IntelliSched (h)"), "Distance from the group's average load (per teacher; balance)", "B2 secondary", "lower"))
    apply_holm(rows)
    table(rows, md)
    same = pd.to_numeric(ac["Manual teacher"].astype(str).str.strip() == ac["IntelliSched teacher"].astype(str).str.strip()).astype(int)
    k, n = int(same.sum()), len(same)
    lo, hi = wilson(k, n)
    md += [f"**Same teacher as the Dean chose:** {k} of {n} classes ({k/n*100:.1f}%, Wilson 95% CI {lo*100:.1f}–{hi*100:.1f}%).", ""]
    rr_rows = []
    for col, name in (("RR engine1", "Engine 1 only (credentials)"), ("RR rule", "Last same-semester teacher rule"), ("RR random", "Random choice")):
        if col in ac:
            r = paired(ac["RR model"], ac[col], f"Rank score of the Dean's teacher: model vs {name}", "B3 ranking", "higher")
            r["Measure"] = f"Model vs {name} (reciprocal rank of the Dean's choice)"
            rr_rows.append(r)
    apply_holm(rr_rows)
    if rr_rows:
        md += ["How well each method ranks the Dean's actual choice (reciprocal rank: 1 = ranked first, 0.5 = second, ...):", ""]
        for r in rr_rows:  # relabel: a = model, b = baseline
            r["better"] = "lower"  # model higher = d > 0 = "IntelliSched better" wording reused below
        table(rr_rows, md)
        md[-len(rr_rows) - 3] = md[-len(rr_rows) - 3].replace("Manual mean (SD)", "Model mean (SD)").replace("IntelliSched mean (SD)", "Simpler method mean (SD)").replace("Difference M − I", "Difference Model − Simpler")
        for i in range(len(md) - len(rr_rows) - 1, len(md) - 1):
            md[i] = md[i].replace("IntelliSched significantly better", "model significantly better").replace("Manual significantly better", "simpler method significantly better")
    summary["assignment"] = rows + rr_rows
    # ranking figure
    meth = [(c, n_) for c, n_ in (("RR model", "IntelliSched model"), ("RR engine1", "Engine 1 only"), ("RR rule", "Same-semester rule"), ("RR random", "Random")) if c in ac]
    if meth:
        fig, ax = plt.subplots(figsize=(6.5, 4.2), dpi=DPI)
        metrics = ["Top-1", "Top-3", "Mean reciprocal rank"]
        x = np.arange(len(metrics))
        w = 0.8 / len(meth)
        cols = [C_IS, "#7fb3d5", "#b0b0b0", "#dcdcdc"]
        for i, (c, n_) in enumerate(meth):
            v = pd.to_numeric(ac[c], errors="coerce")
            if c == "RR random":
                cand = pd.to_numeric(ac["Candidates"], errors="coerce")
                vals = [(1 / cand).mean(), (np.minimum(3, cand) / cand).mean(), v.mean()]
            else:
                vals = [(v >= 0.999).mean(), (v >= 1 / 3 - 1e-9).mean(), v.mean()]
            b = ax.bar(x + (i - (len(meth) - 1) / 2) * w, vals, w, label=n_, color=cols[i % 4])
            for bb, val in zip(b, vals):
                ax.text(bb.get_x() + bb.get_width() / 2, val, f"{val:.2f}", ha="center", va="bottom", fontsize=7)
        ax.set_xticks(x, metrics)
        ax.set_ylim(0, 1.05)
        ax.set_ylabel("Share of classes / score")
        ax.set_title("Does each method put the Dean's actual choice on top?")
        ax.legend(frameon=False, fontsize=8)
        fig.tight_layout()
        fig.savefig(os.path.join(figs, "fig_B3_recommendation_ranking.png"))
        plt.close(fig)
    fig, axes = plt.subplots(1, 2, figsize=(7.5, 3.8), dpi=DPI)
    for ax, (a, b, t) in zip(axes, (("Match manual", "Match IntelliSched", "Credentials match"), ("Taught before manual", "Taught before IntelliSched", "Semesters taught before"))):
        va, vb = pd.to_numeric(ac[a], errors="coerce").dropna(), pd.to_numeric(ac[b], errors="coerce").dropna()
        means = [va.mean(), vb.mean()]
        errs = [stats.t.ppf(0.975, len(s) - 1) * s.std(ddof=1) / np.sqrt(len(s)) if len(s) > 1 else 0 for s in (va, vb)]
        bars = ax.bar([0, 1], means, yerr=errs, capsize=4, color=[C_MAN, C_IS])
        for bb, m in zip(bars, means):
            ax.text(bb.get_x() + bb.get_width() / 2, m, f"{m:.2f}", ha="center", va="bottom", fontsize=8)
        ax.set_xticks([0, 1], ["Manual", "IntelliSched"])
        ax.set_title(f"{t} of the assigned teacher\n(mean per class, 95% CI)", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(figs, "fig_B1_assignment_quality.png"))
    plt.close(fig)
    if af is not None:
        d = af.sort_values("Teacher")
        fig, ax = plt.subplots(figsize=(8, 4.2), dpi=DPI)
        x = np.arange(len(d))
        ax.bar(x - 0.2, d["Load manual (h)"], 0.4, color=C_MAN, label="Manual")
        ax.bar(x + 0.2, d["Load IntelliSched (h)"], 0.4, color=C_IS, label="IntelliSched")
        ax.scatter(x, d["Cap (h)"], marker="_", s=300, color="#c0392b", label="Teaching cap", zorder=3)
        ax.set_xticks(x, [f"T{i+1}" for i in range(len(d))], fontsize=8)
        ax.set_ylabel("Teaching load (h/week)")
        ax.set_title("Teaching load per teacher (teachers coded T1…Tn)")
        ax.legend(frameon=False, fontsize=8)
        fig.tight_layout()
        fig.savefig(os.path.join(figs, "fig_B2_teaching_loads.png"))
        plt.close(fig)
        md += ["Teacher codes in fig_B2: " + ", ".join(f"T{i+1} = {t}" for i, t in enumerate(d["Teacher"])) + ". (Keep this list out of the figure itself.)", ""]


# ---------------------------------------------------------------- runs and fault injection
def runs(folder, figs, md, summary):
    g = load(folder, "ga_runs_ui.csv")
    md += ["## C. IntelliSched runs through the real interface (Playwright)", ""]
    if g is None:
        md += ["ga_runs_ui.csv not found.", ""]
        return
    md += ["| Assignment used | Runs | Conflict-free on screen (Wilson 95% CI) | Validator = checker = screen | Time to result (s), mean ± SD | Approve enabled | Exports ok |",
           "| --- | --- | --- | --- | --- | --- | --- |"]
    for a, x in g.groupby("Assignment", sort=False):
        c = pd.to_numeric(x["Conflicts on screen"], errors="coerce")
        k, n = int((c == 0).sum()), int(c.notna().sum())
        lo, hi = wilson(k, n)
        agree = int(((x["Conflicts on screen"] == x["Validator conflicts"]) & (x["Validator conflicts"] == x["Checker conflicts"])).sum())
        t = pd.to_numeric(x["Time to result (s)"], errors="coerce")
        md.append(f"| {a} | {n} | {k}/{n} ({lo*100:.0f}–{hi*100:.0f}%) | {agree}/{n} | {t.mean():.1f} ± {t.std(ddof=1):.1f} | "
                  f"{int(pd.to_numeric(x['Approve enabled'], errors='coerce').sum())}/{n} | {int(pd.to_numeric(x['Exports ok'], errors='coerce').sum())}/{n} |")
        summary.setdefault("runs", []).append((a, k, n))
    md.append("")
    fig, ax = plt.subplots(figsize=(6.5, 3.6), dpi=DPI)
    for a, x in g.groupby("Assignment", sort=False):
        ax.plot(x["Run"], x["Time to result (s)"], marker="o", label=f"{a} assignment", color=C_IS if a.lower().startswith("dean") else C_PIPE)
    ax.set_xlabel("Run")
    ax.set_ylabel("Seconds from Generate to result")
    ax.set_title("Time from Generate to finished schedule, per run")
    ax.set_ylim(bottom=0)
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(figs, "fig_C1_generation_time.png"))
    plt.close(fig)


def faults(folder, figs, md, summary):
    fi = load(folder, "fault_injection.csv")
    md += ["## D. Conflict-detection test (planted faults)", ""]
    if fi is None:
        md += ["fault_injection.csv not found.", ""]
        return
    for who in ["Validator flagged", "Checker flagged", "UI flagged", "Approve blocked"]:
        x = fi[pd.to_numeric(fi[who], errors="coerce").notna()].copy() if who in fi else pd.DataFrame()
        if x.empty:
            continue
        x[who] = x[who].astype(int)
        pos, neg = x[x["Should be flagged"] == 1], x[x["Should be flagged"] == 0]
        tp, fn, fpos, tn = int(pos[who].sum()), int((1 - pos[who]).sum()), int(neg[who].sum()), int((1 - neg[who]).sum())
        lo, hi = wilson(tp, len(pos))
        b = stats.binomtest(tp, len(pos), 0.95, alternative="greater") if len(pos) else None
        md += [f"**{who}:** detected {tp} of {len(pos)} planted faults ({(tp/len(pos)*100 if len(pos) else float('nan')):.1f}%, Wilson 95% CI {lo*100:.1f}–{hi*100:.1f}%); "
               f"false alarms {fpos} of {len(neg)} clean controls."
               + (f" Exact binomial test of ≥ 95% detection: p = {fp(b.pvalue)}." if b else ""), ""]
        if who == "Validator flagged":
            summary["faults"] = (tp, len(pos), fpos, len(neg))
            md += ["| Fault type | Planted | Detected |", "| --- | --- | --- |"]
            for t, gg in pos.groupby("Fault type"):
                md.append(f"| {t} | {len(gg)} | {int(gg[who].sum())} |")
            for t, gg in neg.groupby("Fault type"):
                md.append(f"| {t} (clean control) | {len(gg)} | {int(gg[who].sum())} false alarms |")
            md.append("")
            fig, ax = plt.subplots(figsize=(4.2, 3.6), dpi=DPI)
            m = np.array([[tp, fn], [fpos, tn]])
            ax.imshow(m, cmap="Blues")
            for i in range(2):
                for j in range(2):
                    ax.text(j, i, str(m[i, j]), ha="center", va="center", fontsize=14, color="white" if m[i, j] > m.max() / 2 else "black")
            ax.set_xticks([0, 1], ["Flagged", "Not flagged"])
            ax.set_yticks([0, 1], ["Fault planted", "Clean control"])
            ax.set_title("System validator: planted-fault test")
            fig.tight_layout()
            fig.savefig(os.path.join(figs, "fig_D1_fault_detection.png"))
            plt.close(fig)
    if {"Validator flagged", "Checker flagged"} <= set(fi):
        x = fi[pd.to_numeric(fi["Checker flagged"], errors="coerce").notna()]
        a, c = x["Validator flagged"].astype(int), x["Checker flagged"].astype(int)
        po = (a == c).mean()
        pe = a.mean() * c.mean() + (1 - a.mean()) * (1 - c.mean())
        k = (po - pe) / (1 - pe) if pe < 1 else None
        md += [f"System validator vs the independently written checker: {po*100:.1f}% agreement, Cohen's kappa {'n/a' if k is None else f'{k:.3f}'}.", ""]


def flow_figure(figs):
    fig, ax = plt.subplots(figsize=(11, 5), dpi=DPI)
    ax.axis("off")
    W, H = 0.19, 0.24
    boxes = {
        "man": (0.01, 0.70, "Office's manual schedule\n2nd Sem AY 2025-26\n(faculty, section, room)", C_MAN),
        "term": (0.01, 0.22, "Same term in IntelliSched\n(classes, sections, rooms,\ncurriculum)", C_IS),
        "dig": (0.26, 0.70, "Manual schedule digitised\n(one row per meeting)", "#a6a6a6"),
        "gen": (0.26, 0.38, "IntelliSched schedules:\n10 runs via Playwright\n(real Generate button)", C_IS),
        "asg": (0.26, 0.06, "IntelliSched faculty\nassignment (model trained\non the 3 earlier terms)", C_IS),
        "chk": (0.53, 0.54, "Same counting rules for both\n(independent checker,\nvalidated by planted faults)", "#5d6d7e"),
        "shap": (0.53, 0.06, "SHAP explanation of\nthe recommendation model", "#5d6d7e"),
        "t1": (0.80, 0.54, "Paired t-tests per\nteacher, section, room\n(+ Wilcoxon, Holm)", "#1b4f72"),
        "t2": (0.80, 0.22, "Paired t-tests on the\nfaculty assignment\n(per class, per teacher)", "#1b4f72"),
    }
    for x, y, t, c in boxes.values():
        ax.add_patch(plt.Rectangle((x, y), W, H, color=c, transform=ax.transAxes))
        ax.text(x + W / 2, y + H / 2, t, ha="center", va="center", fontsize=8, color="white", transform=ax.transAxes)

    def arrow(p, q):
        x0, y0 = boxes[p][0] + W, boxes[p][1] + H / 2
        x1, y1 = boxes[q][0], boxes[q][1] + H / 2
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0), xycoords="axes fraction", arrowprops=dict(arrowstyle="->", color="#555", lw=1.1))
    for p, q in (("man", "dig"), ("term", "gen"), ("term", "asg"), ("dig", "chk"), ("gen", "chk"), ("chk", "t1"), ("asg", "t2"), ("asg", "shap"), ("man", "t2")):
        arrow(p, q)
    ax.set_title("IntelliSched evaluation: manual (Dean and College Secretary) vs IntelliSched, 2nd Semester AY 2025-26", fontsize=11)
    fig.savefig(os.path.join(figs, "fig_0_evaluation_flow.png"), bbox_inches="tight")
    plt.close(fig)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    folder = sys.argv[1]
    figs = os.path.join(folder, "figures")
    os.makedirs(figs, exist_ok=True)
    md = ["# Phase 10 results: manual vs IntelliSched (2nd Sem AY 2025-26)", "",
          "M − I = manual minus IntelliSched. Holm-adjusted p decides the result; Wilcoxon p confirms it.", ""]
    summary = {}
    flow_figure(figs)
    schedule(folder, figs, md, summary)
    room_heatmap(folder, figs, md)
    assignment(folder, figs, md, summary)
    runs(folder, figs, md, summary)
    faults(folder, figs, md, summary)
    md += ["## E. Summary", ""]
    for key in ("schedule", "assignment"):
        for r in summary.get(key, []):
            if "primary" in r["Family"] or "ranking" in r["Family"]:
                md.append(f"- {r['Measure']}: {verdict(r).replace('IntelliSched significantly better', 'IntelliSched significantly better') if 'ranking' not in r['Family'] else verdict(r).replace('IntelliSched significantly better','model significantly better').replace('Manual significantly better','simpler method significantly better')}"
                          + ("" if np.isnan(r["p"]) else f" (Holm p = {fp(r.get('holm'))})"))
    for a, k, n in summary.get("runs", []):
        md.append(f"- Runs with the {a} assignment: {k}/{n} conflict-free.")
    if "faults" in summary:
        tp, npos, fpos, nneg = summary["faults"]
        md.append(f"- Planted faults detected: {tp}/{npos}; false alarms: {fpos}/{nneg}.")
    md.append("")
    text = "\n".join(md)
    open(os.path.join(folder, "results.md"), "w", encoding="utf-8").write(text)
    print(text)
    print(f"\nSaved {os.path.join(folder, 'results.md')} and figures in {figs}")


if __name__ == "__main__":
    main()
