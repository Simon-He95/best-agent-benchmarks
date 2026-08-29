# Benchmark Failure Ledger (final — all 500 tasks)

> **Correction notice (official evaluator audit, 2026-08-21):** the counts below
> are the preserved output of the retired local grader, not final official
> pass@1. Its SymPy path sent 73 bare test names to pytest and never evaluated
> them. Frozen official Docker re-evaluation of the complete 75-task SymPy
> selection produced 57 resolved, 13 test-failed, 3 inconclusive, and 2
> not-evaluated (`passAt1: null`; official coverage 70/75). A mechanical
> replacement would raise the 500-task resolved count from 198 to 255 (51%), but
> this is not published as official pass@1 until cross-repository controls are
> complete. See
> `results/official-audit/sympy-v1/official-transition-report.json` and
> `results/official-audit/sympy-v1/failure-analysis.md`.

- Generated: 2026-08-21T02:37:12.969Z
- CLI: npm beta.8 — ALL batches complete (#67-#76 beta.8 rerun + #77-#83 b4 sphinx/sympy/sklearn)
- Ledger: **500** tasks — **resolved 198 (40%)** | env-blocked 55 | model test-failed 239 | timeout 6 | no-diff 2 | transport-loss 0
- Split: beta.8 rerun 375 tasks = 191 resolved (51%) | b4 new 125 tasks (sphinx/sympy/sklearn) = 7 resolved (5.6%)
- Effective model pass rate (excluding env platform dead-ends): **44%**

## Failure classification (302 failures)

### env-blocked (platform dead-ends — NOT model capability) = 55
- **matplotlib 34** — platform compile dead-ends on macos CI
- **scikit-learn 15** — platform compile dead-ends on macos CI
- **astropy 6** — platform compile dead-ends on macos CI

### model test-failed (historical local-grader label; not established real failures) = 239
- sympy 75 | django 53 | sphinx-doc 37 | pydata 21 | pytest-dev 19 | scikit-learn 17 | astropy 10 | pylint-dev 8 | psf 5 | mwaskom 1 | pallets 1
- Full semantic-gap audit (gold test_patch assertions vs agent patch): docs/failure-gaps.md
- Dominant pattern (deep-audited django 10999/11749/11532/12325 + sympy samples): agent executes the SWE-agent protocol correctly (reproduce→fix→existing tests pass→cleanup) but misses gold-test semantic boundaries (negative inputs, no-arg CommandError, punycode encoding, parent-model edge, subclass/type-preservation, unknown-type comparison, precise math values).

## Task table (302 failed rows)

| instance_id | state | error head |
|---|---|---|
| astropy__astropy-13033 | test-failed | |
| astropy__astropy-13236 | test-failed | |
| astropy__astropy-13398 | test-failed | |
| astropy__astropy-13977 | env-blocked | |
| astropy__astropy-14096 | env-blocked | |
| astropy__astropy-14182 | env-blocked | |
| astropy__astropy-14365 | test-failed | |
| astropy__astropy-14369 | test-failed | |
| astropy__astropy-14508 | test-failed | |
| astropy__astropy-14598 | test-failed | |
| astropy__astropy-7166 | test-failed | |
| astropy__astropy-7336 | test-failed | |
| astropy__astropy-7606 | env-blocked | |
| astropy__astropy-7671 | test-failed | |
| astropy__astropy-8707 | env-blocked | |
| astropy__astropy-8872 | env-blocked | |
| django__django-10999 | test-failed | |
| django__django-11141 | test-failed | |
| django__django-11532 | test-failed | |
| django__django-11749 | test-failed | |
| django__django-11790 | test-failed | |
| django__django-11820 | test-failed | |
| django__django-12273 | test-failed | |
| django__django-12325 | test-failed | |
| django__django-12663 | timeout | |
| django__django-13195 | test-failed | |
| django__django-13212 | test-failed | |
| django__django-13401 | test-failed | |
| django__django-13513 | no-diff | |
| django__django-14011 | test-failed | |
| django__django-14034 | test-failed | |
| django__django-14155 | test-failed | |
| django__django-14170 | test-failed | |
| django__django-14315 | test-failed | |
| django__django-14349 | test-failed | |
| django__django-14376 | test-failed | |
| django__django-15022 | timeout | |
| django__django-15098 | test-failed | |
| django__django-15127 | test-failed | |
| django__django-15252 | test-failed | |
| django__django-15629 | test-failed | |
| django__django-15732 | test-failed | |
| django__django-15916 | test-failed | |
| django__django-16256 | test-failed | |
| django__django-16454 | test-failed | |
| django__django-16485 | test-failed | |
| django__django-16493 | test-failed | |
| django__django-16502 | test-failed | |
| django__django-16527 | test-failed | |
| django__django-16560 | test-failed | |
| django__django-16569 | test-failed | |
| django__django-16595 | test-failed | |
| django__django-16612 | test-failed | |
| django__django-16631 | test-failed | |
| django__django-16642 | test-failed | |
| django__django-16661 | test-failed | |
| django__django-16662 | test-failed | |
| django__django-16667 | test-failed | |
| django__django-16801 | test-failed | |
| django__django-16819 | test-failed | |
| django__django-16877 | test-failed | |
| django__django-16899 | test-failed | |
| django__django-16901 | test-failed | |
| django__django-16938 | test-failed | |
| django__django-16950 | test-failed | |
| django__django-17029 | test-failed | |
| django__django-17084 | test-failed | |
| django__django-17087 | test-failed | |
| django__django-7530 | test-failed | |
| matplotlib__matplotlib-13989 | env-blocked | |
| matplotlib__matplotlib-14623 | env-blocked | |
| matplotlib__matplotlib-20488 | env-blocked | |
| matplotlib__matplotlib-20676 | env-blocked | |
| matplotlib__matplotlib-20826 | env-blocked | |
| matplotlib__matplotlib-20859 | env-blocked | |
| matplotlib__matplotlib-21568 | env-blocked | |
| matplotlib__matplotlib-22719 | env-blocked | |
| matplotlib__matplotlib-22865 | env-blocked | |
| matplotlib__matplotlib-22871 | env-blocked | |
| matplotlib__matplotlib-23299 | env-blocked | |
| matplotlib__matplotlib-23314 | env-blocked | |
| matplotlib__matplotlib-23412 | env-blocked | |
| matplotlib__matplotlib-23476 | env-blocked | |
| matplotlib__matplotlib-24026 | env-blocked | |
| matplotlib__matplotlib-24149 | env-blocked | |
| matplotlib__matplotlib-24177 | env-blocked | |
| matplotlib__matplotlib-24570 | env-blocked | |
| matplotlib__matplotlib-24627 | env-blocked | |
| matplotlib__matplotlib-24637 | env-blocked | |
| matplotlib__matplotlib-24870 | env-blocked | |
| matplotlib__matplotlib-24970 | env-blocked | |
| matplotlib__matplotlib-25122 | env-blocked | |
| matplotlib__matplotlib-25287 | env-blocked | |
| matplotlib__matplotlib-25311 | env-blocked | |
| matplotlib__matplotlib-25332 | env-blocked | |
| matplotlib__matplotlib-25479 | env-blocked | |
| matplotlib__matplotlib-25775 | env-blocked | |
| matplotlib__matplotlib-25960 | env-blocked | |
| matplotlib__matplotlib-26113 | env-blocked | |
| matplotlib__matplotlib-26208 | env-blocked | |
| matplotlib__matplotlib-26291 | env-blocked | |
| matplotlib__matplotlib-26342 | env-blocked | |
| matplotlib__matplotlib-26466 | env-blocked | |
| mwaskom__seaborn-3187 | test-failed | |
| pallets__flask-5014 | test-failed | |
| psf__requests-1921 | test-failed | |
| psf__requests-2317 | test-failed | |
| psf__requests-2931 | test-failed | |
| psf__requests-5414 | test-failed | |
| psf__requests-6028 | test-failed | |
| pydata__xarray-2905 | test-failed | |
| pydata__xarray-3095 | test-failed | |
| pydata__xarray-3151 | test-failed | |
| pydata__xarray-3305 | test-failed | |
| pydata__xarray-3677 | test-failed | |
| pydata__xarray-3993 | test-failed | |
| pydata__xarray-4075 | test-failed | |
| pydata__xarray-4094 | test-failed | |
| pydata__xarray-4356 | test-failed | |
| pydata__xarray-4687 | test-failed | |
| pydata__xarray-4695 | test-failed | |
| pydata__xarray-4966 | test-failed | |
| pydata__xarray-6461 | test-failed | |
| pydata__xarray-6599 | test-failed | |
| pydata__xarray-6721 | test-failed | |
| pydata__xarray-6744 | test-failed | |
| pydata__xarray-6938 | test-failed | |
| pydata__xarray-6992 | test-failed | |
| pydata__xarray-7229 | test-failed | |
| pydata__xarray-7233 | test-failed | |
| pydata__xarray-7393 | test-failed | |
| pylint-dev__pylint-4551 | test-failed | |
| pylint-dev__pylint-4604 | test-failed | |
| pylint-dev__pylint-4661 | test-failed | |
| pylint-dev__pylint-6528 | timeout | |
| pylint-dev__pylint-6903 | test-failed | |
| pylint-dev__pylint-7080 | test-failed | |
| pylint-dev__pylint-7277 | test-failed | |
| pylint-dev__pylint-8898 | test-failed | |
| pytest-dev__pytest-10051 | test-failed | |
| pytest-dev__pytest-10081 | test-failed | |
| pytest-dev__pytest-10356 | test-failed | |
| pytest-dev__pytest-5262 | test-failed | |
| pytest-dev__pytest-5631 | test-failed | |
| pytest-dev__pytest-5787 | test-failed | |
| pytest-dev__pytest-5809 | test-failed | |
| pytest-dev__pytest-5840 | test-failed | |
| pytest-dev__pytest-6197 | test-failed | |
| pytest-dev__pytest-6202 | test-failed | |
| pytest-dev__pytest-7205 | test-failed | |
| pytest-dev__pytest-7236 | test-failed | |
| pytest-dev__pytest-7324 | test-failed | |
| pytest-dev__pytest-7432 | test-failed | |
| pytest-dev__pytest-7490 | test-failed | |
| pytest-dev__pytest-7521 | test-failed | |
| pytest-dev__pytest-7571 | test-failed | |
| pytest-dev__pytest-7982 | test-failed | |
| pytest-dev__pytest-8399 | test-failed | |
| scikit-learn__scikit-learn-10297 | test-failed | |
| scikit-learn__scikit-learn-10844 | test-failed | |
| scikit-learn__scikit-learn-10908 | test-failed | |
| scikit-learn__scikit-learn-11310 | test-failed | |
| scikit-learn__scikit-learn-11578 | test-failed | |
| scikit-learn__scikit-learn-12585 | test-failed | |
| scikit-learn__scikit-learn-12682 | env-blocked | |
| scikit-learn__scikit-learn-12973 | test-failed | |
| scikit-learn__scikit-learn-13124 | test-failed | |
| scikit-learn__scikit-learn-13135 | no-diff | |
| scikit-learn__scikit-learn-13142 | test-failed | |
| scikit-learn__scikit-learn-13328 | env-blocked | |
| scikit-learn__scikit-learn-13439 | env-blocked | |
| scikit-learn__scikit-learn-13496 | env-blocked | |
| scikit-learn__scikit-learn-13779 | env-blocked | |
| scikit-learn__scikit-learn-14053 | env-blocked | |
| scikit-learn__scikit-learn-14087 | env-blocked | |
| scikit-learn__scikit-learn-14141 | env-blocked | |
| scikit-learn__scikit-learn-14496 | env-blocked | |
| scikit-learn__scikit-learn-14629 | env-blocked | |
| scikit-learn__scikit-learn-14710 | env-blocked | |
| scikit-learn__scikit-learn-14894 | env-blocked | |
| scikit-learn__scikit-learn-14983 | env-blocked | |
| scikit-learn__scikit-learn-15100 | env-blocked | |
| scikit-learn__scikit-learn-25102 | test-failed | |
| scikit-learn__scikit-learn-25232 | test-failed | |
| scikit-learn__scikit-learn-25747 | test-failed | |
| scikit-learn__scikit-learn-25931 | test-failed | |
| scikit-learn__scikit-learn-25973 | test-failed | |
| scikit-learn__scikit-learn-26194 | test-failed | |
| scikit-learn__scikit-learn-26323 | test-failed | |
| scikit-learn__scikit-learn-9288 | env-blocked | |
| sphinx-doc__sphinx-10323 | test-failed | |
| sphinx-doc__sphinx-10435 | test-failed | |
| sphinx-doc__sphinx-7440 | test-failed | |
| sphinx-doc__sphinx-7454 | test-failed | |
| sphinx-doc__sphinx-7462 | test-failed | |
| sphinx-doc__sphinx-7590 | test-failed | |
| sphinx-doc__sphinx-7748 | test-failed | |
| sphinx-doc__sphinx-7757 | test-failed | |
| sphinx-doc__sphinx-7889 | test-failed | |
| sphinx-doc__sphinx-7910 | test-failed | |
| sphinx-doc__sphinx-7985 | test-failed | |
| sphinx-doc__sphinx-8035 | test-failed | |
| sphinx-doc__sphinx-8056 | test-failed | |
| sphinx-doc__sphinx-8120 | test-failed | |
| sphinx-doc__sphinx-8265 | test-failed | |
| sphinx-doc__sphinx-8269 | test-failed | |
| sphinx-doc__sphinx-8459 | test-failed | |
| sphinx-doc__sphinx-8475 | test-failed | |
| sphinx-doc__sphinx-8548 | test-failed | |
| sphinx-doc__sphinx-8551 | test-failed | |
| sphinx-doc__sphinx-8593 | test-failed | |
| sphinx-doc__sphinx-8595 | test-failed | |
| sphinx-doc__sphinx-8621 | test-failed | |
| sphinx-doc__sphinx-8638 | test-failed | |
| sphinx-doc__sphinx-8721 | test-failed | |
| sphinx-doc__sphinx-9229 | timeout | |
| sphinx-doc__sphinx-9230 | test-failed | |
| sphinx-doc__sphinx-9258 | test-failed | |
| sphinx-doc__sphinx-9281 | test-failed | |
| sphinx-doc__sphinx-9320 | test-failed | |
| sphinx-doc__sphinx-9367 | test-failed | |
| sphinx-doc__sphinx-9461 | test-failed | |
| sphinx-doc__sphinx-9591 | test-failed | |
| sphinx-doc__sphinx-9602 | test-failed | |
| sphinx-doc__sphinx-9673 | test-failed | |
| sphinx-doc__sphinx-9698 | test-failed | |
| sphinx-doc__sphinx-9711 | test-failed | |
| sympy__sympy-11618 | test-failed | |
| sympy__sympy-12096 | test-failed | |
| sympy__sympy-12419 | test-failed | |
| sympy__sympy-12481 | test-failed | |
| sympy__sympy-12489 | test-failed | |
| sympy__sympy-13031 | test-failed | |
| sympy__sympy-13091 | test-failed | |
| sympy__sympy-13372 | test-failed | |
| sympy__sympy-13480 | test-failed | |
| sympy__sympy-13551 | test-failed | |
| sympy__sympy-13615 | test-failed | |
| sympy__sympy-13647 | test-failed | |
| sympy__sympy-13757 | test-failed | |
| sympy__sympy-13798 | test-failed | |
| sympy__sympy-13852 | test-failed | |
| sympy__sympy-13877 | test-failed | |
| sympy__sympy-13878 | test-failed | |
| sympy__sympy-13974 | test-failed | |
| sympy__sympy-14248 | timeout | |
| sympy__sympy-14531 | test-failed | |
| sympy__sympy-14711 | test-failed | |
| sympy__sympy-14976 | test-failed | |
| sympy__sympy-15017 | test-failed | |
| sympy__sympy-15345 | test-failed | |
| sympy__sympy-15349 | test-failed | |
| sympy__sympy-15599 | test-failed | |
| sympy__sympy-15809 | test-failed | |
| sympy__sympy-15875 | test-failed | |
| sympy__sympy-15976 | test-failed | |
| sympy__sympy-16450 | test-failed | |
| sympy__sympy-16597 | test-failed | |
| sympy__sympy-16766 | test-failed | |
| sympy__sympy-16792 | test-failed | |
| sympy__sympy-16886 | test-failed | |
| sympy__sympy-17139 | test-failed | |
| sympy__sympy-17318 | test-failed | |
| sympy__sympy-17630 | test-failed | |
| sympy__sympy-17655 | test-failed | |
| sympy__sympy-18189 | test-failed | |
| sympy__sympy-18199 | test-failed | |
| sympy__sympy-18211 | test-failed | |
| sympy__sympy-18698 | test-failed | |
| sympy__sympy-18763 | test-failed | |
| sympy__sympy-19040 | test-failed | |
| sympy__sympy-19346 | test-failed | |
| sympy__sympy-19495 | test-failed | |
| sympy__sympy-19637 | test-failed | |
| sympy__sympy-19783 | test-failed | |
| sympy__sympy-19954 | test-failed | |
| sympy__sympy-20154 | test-failed | |
| sympy__sympy-20428 | test-failed | |
| sympy__sympy-20438 | timeout | |
| sympy__sympy-20590 | test-failed | |
| sympy__sympy-20801 | test-failed | |
| sympy__sympy-20916 | test-failed | |
| sympy__sympy-21379 | test-failed | |
| sympy__sympy-21596 | test-failed | |
| sympy__sympy-21612 | test-failed | |
| sympy__sympy-21847 | test-failed | |
| sympy__sympy-21930 | test-failed | |
| sympy__sympy-22080 | test-failed | |
| sympy__sympy-22456 | test-failed | |
| sympy__sympy-22714 | test-failed | |
| sympy__sympy-22914 | test-failed | |
| sympy__sympy-23262 | test-failed | |
| sympy__sympy-23413 | test-failed | |
| sympy__sympy-23534 | test-failed | |
| sympy__sympy-23824 | test-failed | |
| sympy__sympy-23950 | test-failed | |
| sympy__sympy-24066 | test-failed | |
| sympy__sympy-24213 | test-failed | |
| sympy__sympy-24443 | test-failed | |
| sympy__sympy-24539 | test-failed | |
| sympy__sympy-24562 | test-failed | |
| sympy__sympy-24661 | test-failed | |
