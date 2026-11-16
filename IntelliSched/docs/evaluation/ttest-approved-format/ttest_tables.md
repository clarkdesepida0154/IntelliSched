# Paired t-tests in the approved format (Phase 10 data, 2nd Sem AY 2025-26)

Paired-samples t-test, two-tailed, α = .05; significance decided by the Holm-adjusted p within the Phase 10 families (A1, A2, B1, B2, B3); Cohen's d = mean difference ÷ SD of the differences (Phase 10's d_z). Measure 1 − Measure 2 = Manual − IntelliSched (Model − simpler method for C). IntelliSched's schedule values are the mean of its 10 runs per unit. SE = SD ÷ √N. Units are anonymous; no teacher, section or room is named.

Check: every t, df, p, Holm p and d equals docs/eval/phase10/results.md to 3 decimals (20 tests, 140 values).

## A. Schedule Generation

**Table 1. Descriptive Comparison of Schedule Generation**

| Measure | Group | N | Mean | Median | SD | SE |
| --- | --- | --- | --- | --- | --- | --- |
| Faculty: hard problems per teacher | Manual | 16 | 0.000 | 0.000 | 0.000 | 0.000 |
| Faculty: hard problems per teacher | IntelliSched | 16 | 0.000 | 0.000 | 0.000 | 0.000 |
| Faculty: rule breaks | Manual | 16 | 0.812 | 0.000 | 1.328 | 0.332 |
| Faculty: rule breaks | IntelliSched | 16 | 0.081 | 0.000 | 0.223 | 0.056 |
| Faculty: idle gap hours | Manual | 16 | 2.688 | 1.500 | 3.092 | 0.773 |
| Faculty: idle gap hours | IntelliSched | 16 | 0.666 | 0.650 | 0.476 | 0.119 |
| Faculty: single-class days | Manual | 16 | 0.938 | 1.000 | 0.772 | 0.193 |
| Faculty: single-class days | IntelliSched | 16 | 0.669 | 0.700 | 0.605 | 0.151 |
| Faculty: days used | Manual | 16 | 4.188 | 4.000 | 0.750 | 0.188 |
| Faculty: days used | IntelliSched | 16 | 3.806 | 3.950 | 0.807 | 0.202 |
| Section: hard problems per section | Manual | 19 | 0.000 | 0.000 | 0.000 | 0.000 |
| Section: hard problems per section | IntelliSched | 19 | 0.000 | 0.000 | 0.000 | 0.000 |
| Section: rule breaks | Manual | 19 | 0.421 | 0.000 | 0.769 | 0.176 |
| Section: rule breaks | IntelliSched | 19 | 0.000 | 0.000 | 0.000 | 0.000 |
| Section: idle gap hours | Manual | 19 | 2.105 | 2.000 | 1.729 | 0.397 |
| Section: idle gap hours | IntelliSched | 19 | 0.366 | 0.250 | 0.367 | 0.084 |
| Section: single-class days | Manual | 19 | 0.263 | 0.000 | 0.452 | 0.104 |
| Section: single-class days | IntelliSched | 19 | 0.347 | 0.200 | 0.376 | 0.086 |
| Section: days used | Manual | 19 | 3.684 | 4.000 | 1.493 | 0.342 |
| Section: days used | IntelliSched | 19 | 4.053 | 4.500 | 1.580 | 0.363 |
| Room: hard problems per room | Manual | 7 | 0.000 | 0.000 | 0.000 | 0.000 |
| Room: hard problems per room | IntelliSched | 7 | 0.000 | 0.000 | 0.000 | 0.000 |
| Room: rule breaks | Manual | 7 | 1.000 | 1.000 | 1.000 | 0.378 |
| Room: rule breaks | IntelliSched | 7 | 0.000 | 0.000 | 0.000 | 0.000 |

**Table 2. Results of the Paired Samples T-Test on Schedule Generation**

| Measure | T-Test | Statistic | df | p | Holm p | Mean Difference | Effect Size (Cohen's d) | Interpretation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Faculty: hard problems per teacher | Student's t | — | — | — | — | 0.000 | — | Manual and IntelliSched have the same value on every unit for hard problems per teacher (mean 0.000), so the test cannot be computed; there is no difference. |
| Faculty: rule breaks | Student's t | 2.399 | 15 | 0.030 | 0.169 | 0.731 | 0.600 | There is no statistically significant difference in rule breaks per teacher between Manual (0.812) and IntelliSched (0.081), t(15) = 2.399, p = .030, Holm p = .169, d = 0.600 (the unadjusted p is below .05, but not after the Holm correction). |
| Faculty: idle gap hours | Student's t | 2.713 | 15 | 0.016 | 0.112 | 2.022 | 0.678 | There is no statistically significant difference in idle gap hours per teacher between Manual (2.688) and IntelliSched (0.666), t(15) = 2.713, p = .016, Holm p = .112, d = 0.678 (the unadjusted p is below .05, but not after the Holm correction). |
| Faculty: single-class days | Student's t | 1.563 | 15 | 0.139 | 0.278 | 0.269 | 0.391 | There is no statistically significant difference in single-class days per teacher between Manual (0.938) and IntelliSched (0.669), t(15) = 1.563, p = .139, Holm p = .278, d = 0.391. |
| Faculty: days used | Student's t | 2.165 | 15 | 0.047 | 0.169 | 0.381 | 0.541 | There is no statistically significant difference in days used per teacher between Manual (4.188) and IntelliSched (3.806), t(15) = 2.165, p = .047, Holm p = .169, d = 0.541 (the unadjusted p is below .05, but not after the Holm correction). |
| Section: hard problems per section | Student's t | — | — | — | — | 0.000 | — | Manual and IntelliSched have the same value on every unit for hard problems per section (mean 0.000), so the test cannot be computed; there is no difference. |
| Section: rule breaks | Student's t | 2.388 | 18 | 0.028 | 0.169 | 0.421 | 0.548 | There is no statistically significant difference in rule breaks per section between Manual (0.421) and IntelliSched (0.000), t(18) = 2.388, p = .028, Holm p = .169, d = 0.548 (the unadjusted p is below .05, but not after the Holm correction). |
| Section: idle gap hours | Student's t | 4.161 | 18 | < .001 | 0.005 | 1.739 | 0.955 | IntelliSched is significantly better: the value is lower with IntelliSched for idle gap hours per section (2.105 Manual vs 0.366 IntelliSched), t(18) = 4.161, p < .001, Holm p = .005, d = 0.955. |
| Section: single-class days | Student's t | -0.884 | 18 | 0.388 | 0.388 | -0.084 | -0.203 | There is no statistically significant difference in single-class days per section between Manual (0.263) and IntelliSched (0.347), t(18) = -0.884, p = .388, Holm p = .388, d = -0.203. |
| Section: days used | Student's t | -5.351 | 18 | < .001 | < .001 | -0.368 | -1.228 | There is a statistically significant difference in days used per section between Manual (3.684) and IntelliSched (4.053), t(18) = -5.351, p < .001, Holm p < .001, d = -1.228: IntelliSched uses more days; fewer or more days is not counted as better or worse. |
| Room: hard problems per room | Student's t | — | — | — | — | 0.000 | — | Manual and IntelliSched have the same value on every unit for hard problems per room (mean 0.000), so the test cannot be computed; there is no difference. |
| Room: rule breaks | Student's t | 2.646 | 6 | 0.038 | 0.169 | 1.000 | 1.000 | There is no statistically significant difference in rule breaks per room between Manual (1.000) and IntelliSched (0.000), t(6) = 2.646, p = .038, Holm p = .169, d = 1.000 (the unadjusted p is below .05, but not after the Holm correction). |

Note. Hₐ: μ(Measure 1 − Measure 2) ≠ 0; Measure 1 − Measure 2 = Manual − IntelliSched. A dash (—): identical on every unit; the test cannot be computed (no variation in the differences).

**Figure 1. Mean and Median of Schedule Generation** (fig_ttest_schedule_mean_median.png): each group's mean as a circle with its 95% CI, the median as a square.

## B. Faculty Assignment

**Table 3. Descriptive Comparison of Faculty Assignment**

| Measure | Group | N | Mean | Median | SD | SE |
| --- | --- | --- | --- | --- | --- | --- |
| Credentials match of the assigned teacher (per class) | Manual | 64 | 0.051 | 0.025 | 0.071 | 0.009 |
| Credentials match of the assigned teacher (per class) | IntelliSched | 64 | 0.057 | 0.019 | 0.084 | 0.010 |
| Semesters the assigned teacher taught the subject before (per class) | Manual | 64 | 0.781 | 1.000 | 0.417 | 0.052 |
| Semesters the assigned teacher taught the subject before (per class) | IntelliSched | 64 | 0.875 | 1.000 | 0.333 | 0.042 |
| Hours over the teaching cap (per teacher) | Manual | 17 | 0.000 | 0.000 | 0.000 | 0.000 |
| Hours over the teaching cap (per teacher) | IntelliSched | 17 | 0.000 | 0.000 | 0.000 | 0.000 |
| Different subjects to prepare (per teacher) | Manual | 17 | 2.529 | 3.000 | 1.068 | 0.259 |
| Different subjects to prepare (per teacher) | IntelliSched | 17 | 2.471 | 2.000 | 1.419 | 0.344 |
| Distance from the group's average load (per teacher; balance) | Manual | 17 | 4.836 | 3.500 | 3.834 | 0.930 |
| Distance from the group's average load (per teacher; balance) | IntelliSched | 17 | 6.926 | 5.400 | 6.225 | 1.510 |

**Table 4. Results of the Paired Samples T-Test on Faculty Assignment**

| Measure | T-Test | Statistic | df | p | Holm p | Mean Difference | Effect Size (Cohen's d) | Interpretation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Credentials match of the assigned teacher (per class) | Student's t | -0.829 | 63 | 0.410 | 0.410 | -0.007 | -0.104 | There is no statistically significant difference in the credentials match of the assigned teacher per class between Manual (0.051) and IntelliSched (0.057), t(63) = -0.829, p = .410, Holm p = .410, d = -0.104. |
| Semesters the assigned teacher taught the subject before (per class) | Student's t | -2.553 | 63 | 0.013 | 0.026 | -0.094 | -0.319 | IntelliSched is significantly better: the value is higher with IntelliSched for the assigned teacher's earlier experience with the subject per class (0.781 Manual vs 0.875 IntelliSched), t(63) = -2.553, p = .013, Holm p = .026, d = -0.319. |
| Hours over the teaching cap (per teacher) | Student's t | — | — | — | — | 0.000 | — | Manual and IntelliSched have the same value on every unit for the hours over the teaching cap per teacher (mean 0.000), so the test cannot be computed; there is no difference. |
| Different subjects to prepare (per teacher) | Student's t | 0.187 | 16 | 0.854 | 0.854 | 0.059 | 0.045 | There is no statistically significant difference in the number of different subjects each teacher prepares between Manual (2.529) and IntelliSched (2.471), t(16) = 0.187, p = .854, Holm p = .854, d = 0.045. |
| Distance from the group's average load (per teacher; balance) | Student's t | -1.123 | 16 | 0.278 | 0.556 | -2.090 | -0.272 | There is no statistically significant difference in each teacher's distance from the group's average load (load balance) between Manual (4.836) and IntelliSched (6.926), t(16) = -1.123, p = .278, Holm p = .556, d = -0.272. |

Note. Hₐ: μ(Measure 1 − Measure 2) ≠ 0; Measure 1 − Measure 2 = Manual − IntelliSched. A dash (—): identical on every unit; the test cannot be computed (no variation in the differences).

**Figure 2. Mean and Median of Faculty Assignment** (fig_ttest_assignment_mean_median.png): each group's mean as a circle with its 95% CI, the median as a square.

## C. Faculty Recommendation Ranking

**Table 5. Descriptive Comparison of Faculty Recommendation Ranking**

| Measure | Group | N | Mean | Median | SD | SE |
| --- | --- | --- | --- | --- | --- | --- |
| Reciprocal rank of the Dean's choice | Model | 70 | 0.744 | 1.000 | 0.363 | 0.043 |
| Reciprocal rank of the Dean's choice | Credentials only | 70 | 0.288 | 0.143 | 0.302 | 0.036 |
| Reciprocal rank of the Dean's choice | Last same-semester teacher rule | 70 | 0.711 | 1.000 | 0.401 | 0.048 |
| Reciprocal rank of the Dean's choice | Random choice | 70 | 0.202 | 0.202 | 0.000 | 0.000 |

**Table 6. Results of the Paired Samples T-Test on Faculty Recommendation Ranking**

| Measure | T-Test | Statistic | df | p | Holm p | Mean Difference | Effect Size (Cohen's d) | Interpretation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Model − Credentials only | Student's t | 9.119 | 69 | < .001 | < .001 | 0.456 | 1.090 | The model ranks the Dean's actual choice significantly higher than the credentials-only ranking (0.744 vs 0.288), t(69) = 9.119, p < .001, Holm p < .001, d = 1.090. |
| Model − Last same-semester teacher rule | Student's t | 1.518 | 69 | 0.134 | 0.134 | 0.033 | 0.181 | There is no statistically significant difference in the reciprocal rank of the Dean's actual choice between the model (0.744) and the last same-semester teacher rule (0.711), t(69) = 1.518, p = .134, Holm p = .134, d = 0.181. |
| Model − Random choice | Student's t | 12.499 | 69 | < .001 | < .001 | 0.542 | 1.494 | The model ranks the Dean's actual choice significantly higher than a random choice (0.744 vs 0.202), t(69) = 12.499, p < .001, Holm p < .001, d = 1.494. |

Note. Hₐ: μ(Measure 1 − Measure 2) ≠ 0; Measure 1 − Measure 2 = Model − the simpler method (reciprocal rank of the Dean's actual choice). A dash (—): identical on every unit; the test cannot be computed (no variation in the differences).

**Figure 3. Mean and Median of Faculty Recommendation Ranking** (fig_ttest_ranking_mean_median.png): each group's mean as a circle with its 95% CI, the median as a square.

