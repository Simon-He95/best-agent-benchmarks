# Benchmark Failure Ledger (final)

- Generated: 2026-08-20T22:43:54.264Z
- CLI: npm beta.8 (rerun campaign #67-#76 completed)
- Ledger: **375** tasks — **resolved 191 (51%)** | env-blocked 54 | model test-failed 125 | timeout 3 | no-diff 2 | transport-loss 0
- Effective model pass rate (excluding env platform dead-ends): **60%**

## Failure classification

### env-blocked (platform dead-ends — NOT model capability) = 54
- **matplotlib 34** — freetype 2.6.1 / Xcode 26 SDK / OpenMP missing (compile dead-ends, no upstream fix on macos CI)
- **scikit-learn 14** — -fopenmp (no libomp), Cython/setuptools pins exhausted
- **astropy 6** — Xcode 26 SDK (13977/14182/8707/8872), setup_requires dead-end

### model test-failed (real capability failures) = 125
- django 53 | pydata(pandas) 21 | pytest-dev 19 | scikit-learn 12 | astropy 10 | pylint-dev 8 | psf 5 | mwaskom 1 | pallets 1
- Full semantic-gap audit (gold test_patch assertions vs agent patch): docs/failure-gaps.md
- Dominant pattern (deep-audited django 10999/11749/11532/12325): agent executes the SWE-agent protocol correctly (reproduce→fix→existing tests pass→cleanup) but misses gold-test semantic boundaries (negative inputs, no-arg CommandError, punycode encoding, parent-model edge).

## Task table

| instance_id | state | latest batch | error head |
|---|---|---|---|
| astropy__astropy-13033 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-13033-V5hkDI/r |
| astropy__astropy-13236 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-13236-tXwu7P/r |
| astropy__astropy-13398 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-13398-LPDnb5/r |
| astropy__astropy-13977 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-13977-wkoghf/r |
| astropy__astropy-14096 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14096-RR9GN2/r |
| astropy__astropy-14182 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14182-Y3Cufw/r |
| astropy__astropy-14365 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14365-2dm5T3/r |
| astropy__astropy-14369 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14369-XXRhIJ/r |
| astropy__astropy-14508 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14508-6YqiMr/r |
| astropy__astropy-14598 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14598-v3gMfK/r |
| astropy__astropy-7166 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-7166-1RTD80/re |
| astropy__astropy-7336 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-7336-AiicJY/re |
| astropy__astropy-7606 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-7606-lOXI2a/re |
| astropy__astropy-7671 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-7671-y0hjFV/re |
| astropy__astropy-8707 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-8707-48M2Cc/re |
| astropy__astropy-8872 | env-blocked | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-8872-l4wp2w/re |
| django__django-10999 | test-failed | artsr | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-10999-iThtCs/rep |
| django__django-11141 | test-failed | artifacts | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11141-KtXZXL/rep |
| django__django-11532 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11532-YKwG6T/rep |
| django__django-11749 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11749-LMxJFQ/rep |
| django__django-11790 | test-failed | artsr | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11790-Ae13Jp/rep |
| django__django-11820 | test-failed | artifacts | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11820-1agrJ0/rep |
| django__django-12273 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-12273-RWpMX2/rep |
| django__django-12325 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-12325-XyWmmE/rep |
| django__django-12663 | timeout | artb1n |  |
| django__django-13195 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13195-mg3edg/rep |
| django__django-13212 | test-failed | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13212-qKXnEA/rep |
| django__django-13401 | test-failed | artifacts | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13401-DLznQ5/rep |
| django__django-13513 | no-diff | artb1n | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13513-NBHEYg/rep |
| django__django-14011 | test-failed | artb2 | Test patch did not apply cleanly. |
| django__django-14034 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14034-jjly0U/rep |
| django__django-14155 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14155-JNrgHR/rep |
| django__django-14170 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14170-lnETYP/rep |
| django__django-14315 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14315-QkaHEU/rep |
| django__django-14349 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14349-2N3Ght/rep |
| django__django-14376 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14376-JCnIGE/rep |
| django__django-15022 | timeout | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15022-YBXMDc/rep |
| django__django-15098 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15098-amyIwf/rep |
| django__django-15127 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15127-jHgmmt/rep |
| django__django-15252 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15252-F74Ixh/rep |
| django__django-15629 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15629-PFYqfz/rep |
| django__django-15732 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15732-YWn46f/rep |
| django__django-15916 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15916-eoMupJ/rep |
| django__django-16256 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16256-anhGzD/rep |
| django__django-16454 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16454-6od7nt/rep |
| django__django-16485 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16485-KDK2HJ/rep |
| django__django-16493 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16493-0lWr1M/rep |
| django__django-16502 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16502-VryRG0/rep |
| django__django-16527 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16527-F6vOuU/rep |
| django__django-16560 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16560-3ZJmVv/rep |
| django__django-16569 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16569-pH07Dv/rep |
| django__django-16595 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16595-5Dsm0L/rep |
| django__django-16612 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16612-kQ7txr/rep |
| django__django-16631 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16631-rp2UCK/rep |
| django__django-16642 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16642-jcCM1N/rep |
| django__django-16661 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16661-URSzAO/rep |
| django__django-16662 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16662-N12IUn/rep |
| django__django-16667 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16667-KTBbId/rep |
| django__django-16801 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16801-0ny3v3/rep |
| django__django-16819 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16819-cLSDVX/rep |
| django__django-16877 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16877-GnutpJ/rep |
| django__django-16899 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16899-LyCo1q/rep |
| django__django-16901 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16901-OfU1AG/rep |
| django__django-16938 | test-failed | artsr2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16938-FJcCuq/rep |
| django__django-16950 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16950-9otwr8/rep |
| django__django-17029 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-17029-AkFKjx/rep |
| django__django-17084 | test-failed | artb2 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-17084-ZdlwV0/rep |
| django__django-17087 | test-failed | art-rb5 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-17087-GpQZ11/rep |
| django__django-7530 | test-failed | art-rb5 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-7530-uaGVrR/repo |
| matplotlib__matplotlib-13989 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-14623 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-20488 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-20676 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-20826 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-20859 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-21568 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-22719 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-22865 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-22871 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-23299 | env-blocked | art-rerunenv | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-23299-7u |
| matplotlib__matplotlib-23314 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-23412 | env-blocked | art-rb5 | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-23476 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-24026 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| matplotlib__matplotlib-24149 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24177 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24570 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24627 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24637 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24870 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-24970 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25122 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25287 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25311 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25332 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25479 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25775 | env-blocked | art-rb5 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-25960 | env-blocked | art-rb6 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-26113 | env-blocked | art-rerunnpm | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-26208 | env-blocked | art-trans | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-26291 | env-blocked | art-rb6 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-26342 | env-blocked | art-rb6 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| matplotlib__matplotlib-26466 | env-blocked | art-rb6 | error: subprocess-exited-with-error × Building editable for matplotlib (pyproject.tom |
| mwaskom__seaborn-3187 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-mwaskom__seaborn-3187-NCDsPj/re |
| pallets__flask-5014 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pallets__flask-5014-euntNi/repo |
| psf__requests-1921 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-1921-B6t8l5/repo/ |
| psf__requests-2317 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-2317-PrWhp8/repo/ |
| psf__requests-2931 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-2931-a0qenr/repo/ |
| psf__requests-5414 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-5414-vb6UD4/repo/ |
| psf__requests-6028 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-6028-fvmaAR/repo/ |
| pydata__xarray-2905 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-2905-5PonqS/repo |
| pydata__xarray-3095 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3095-FV2RWW/repo |
| pydata__xarray-3151 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3151-leHVHx/repo |
| pydata__xarray-3305 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3305-WKh4Rp/repo |
| pydata__xarray-3677 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3677-W6CFxD/repo |
| pydata__xarray-3993 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3993-lXbbfb/repo |
| pydata__xarray-4075 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4075-E2kobL/repo |
| pydata__xarray-4094 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4094-yPZwGH/repo |
| pydata__xarray-4356 | test-failed | art-rb6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4356-6Rx3un/repo |
| pydata__xarray-4687 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4687-nsYLvg/repo |
| pydata__xarray-4695 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4695-pfJfib/repo |
| pydata__xarray-4966 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4966-oxhMzF/repo |
| pydata__xarray-6461 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6461-gEDnw9/repo |
| pydata__xarray-6599 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6599-h9r2mn/repo |
| pydata__xarray-6721 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6721-Hb52wQ/repo |
| pydata__xarray-6744 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6744-0cp60U/repo |
| pydata__xarray-6938 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6938-7CGC04/repo |
| pydata__xarray-6992 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6992-XAqY4Y/repo |
| pydata__xarray-7229 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-7229-GF0k6G/repo |
| pydata__xarray-7233 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-7233-SllJVj/repo |
| pydata__xarray-7393 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-7393-6GmVre/repo |
| pylint-dev__pylint-4551 | test-failed | art-trans | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-4551-oC3lFU/ |
| pylint-dev__pylint-4604 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-4604-Q5jH2k/ |
| pylint-dev__pylint-4661 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-4661-GYgZ4l/ |
| pylint-dev__pylint-6528 | timeout | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-6528-VOgpAG/ |
| pylint-dev__pylint-6903 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-6903-UrC0xT/ |
| pylint-dev__pylint-7080 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-7080-biqrnT/ |
| pylint-dev__pylint-7277 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-7277-5RThEU/ |
| pylint-dev__pylint-8898 | test-failed | art-rb7 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-8898-MIdS4m/ |
| pytest-dev__pytest-10051 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-10051-DmQdhy |
| pytest-dev__pytest-10081 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-10081-1Y7FOC |
| pytest-dev__pytest-10356 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-10356-2iT3J4 |
| pytest-dev__pytest-5262 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5262-N6D0lJ/ |
| pytest-dev__pytest-5631 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5631-h9rxmk/ |
| pytest-dev__pytest-5787 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5787-DSzryq/ |
| pytest-dev__pytest-5809 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5809-0sk0aV/ |
| pytest-dev__pytest-5840 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5840-zgnlQJ/ |
| pytest-dev__pytest-6197 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-6197-I4MUaC/ |
| pytest-dev__pytest-6202 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-6202-K7jMtM/ |
| pytest-dev__pytest-7205 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7205-pY1QxN/ |
| pytest-dev__pytest-7236 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7236-F502xM/ |
| pytest-dev__pytest-7324 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7324-z7MqTD/ |
| pytest-dev__pytest-7432 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7432-1E9rxP/ |
| pytest-dev__pytest-7490 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7490-QnEqFs/ |
| pytest-dev__pytest-7521 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7521-yRtcoV/ |
| pytest-dev__pytest-7571 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7571-tHnxuy/ |
| pytest-dev__pytest-7982 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7982-hxeX93/ |
| pytest-dev__pytest-8399 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-8399-yncf9U/ |
| scikit-learn__scikit-learn-10297 | test-failed | art-rb8 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1029 |
| scikit-learn__scikit-learn-10844 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1084 |
| scikit-learn__scikit-learn-10908 | test-failed | art-rb9 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1090 |
| scikit-learn__scikit-learn-11310 | test-failed | art-b3env6 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1131 |
| scikit-learn__scikit-learn-11578 | test-failed | art-rb9 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1157 |
| scikit-learn__scikit-learn-12585 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1258 |
| scikit-learn__scikit-learn-12682 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-12973 | test-failed | art-rb9 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1297 |
| scikit-learn__scikit-learn-13124 | test-failed | art-b3tr | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1312 |
| scikit-learn__scikit-learn-13135 | no-diff | art-rb9 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1313 |
| scikit-learn__scikit-learn-13142 | test-failed | art-rerunnpm | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-1314 |
| scikit-learn__scikit-learn-13328 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-13439 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-13496 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-13779 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14053 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14087 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14141 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14496 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14629 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14710 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14894 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-14983 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-15100 | env-blocked | art-rerunenv | error: subprocess-exited-with-error × python setup.py develop did not run success |
| scikit-learn__scikit-learn-25102 | test-failed | art-b3env5 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-2510 |
| scikit-learn__scikit-learn-25232 | test-failed | art-rb9 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-scikit-learn__scikit-learn-2523 |

