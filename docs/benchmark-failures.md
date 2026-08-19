# Benchmark Failure Ledger (for debugging)

- Generated: 2026-08-19T12:58:06.601Z
- Failed tasks: 210 / 375 (official no-hints ledger)
- Full debug material (agentPatch, environmentError, cliError, agentTrace) lives in `.tmp/art-*` fragments; re-fetch any run with `gh run download <run-id> --dir .tmp/art-<batch>`.

| instance_id | state | batch | wallMs | patchLines | error head |
|---|---|---|---|---|---|
| astropy__astropy-12907 | env-blocked | art-b1-nopatch2 | 584s | 14 |  | |
| astropy__astropy-13033 | env-blocked | art-astropyenv | 853s | 36 |  | |
| astropy__astropy-13236 | env-blocked | art-b1-nopatch2 | 609s | 42 |  | |
| astropy__astropy-13398 | unknown | artb1n | 1810s | - |  | |
| astropy__astropy-13453 | no-diff | art-rerun22 | 98s | - |  | |
| astropy__astropy-13579 | env-blocked | art-astropyenv | 986s | 30 |  | |
| astropy__astropy-13977 | env-blocked | art-astropyenv | 1589s | 115 |  | |
| astropy__astropy-14096 | env-blocked | art-b1-nopatch2 | 922s | 67 |  | |
| astropy__astropy-14182 | env-blocked | art-astropyenv | 827s | 48 |  | |
| astropy__astropy-14309 | env-blocked | art-b1-nopatch2 | 375s | 44 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14309-lMgj7G/repo/.swe-bench-venv/ | |
| astropy__astropy-14365 | env-blocked | art-b1-nopatch2 | 240s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14365-Vmzkjt/repo/.swe-bench-venv/ | |
| astropy__astropy-14369 | env-blocked | art-b1-nopatch2 | 681s | 115 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-astropy__astropy-14369-SH1eWO/repo/.swe-bench-venv/ | |
| astropy__astropy-14508 | test-failed | art-rerun22 | 750s | 36 |  | |
| astropy__astropy-14539 | env-blocked | art-b1-nopatch2 | 488s | 14 |  | |
| astropy__astropy-14598 | env-blocked | art-b1-nopatch2 | 885s | 40 |  | |
| astropy__astropy-14995 | env-blocked | art-b1-nopatch2 | 367s | 14 |  | |
| astropy__astropy-7166 | test-failed | art-rerun22 | 580s | 14 |  | |
| astropy__astropy-7336 | test-failed | art-b1-nopatch2 | 280s | 19 |  | |
| astropy__astropy-7606 | env-blocked | art-b1-nopatch2 | 396s | 21 |  | |
| astropy__astropy-7671 | env-blocked | art-astropyenv | 505s | 34 |  | |
| astropy__astropy-8707 | env-blocked | art-astropyenv | 1958s | 63 |  | |
| astropy__astropy-8872 | env-blocked | art-astropyenv | 698s | 23 |  | |
| django__django-10554 | transport-loss | art-nohints1 | 2530s | - |  | |
| django__django-10999 | test-failed | art-nohints1 | 243s | 14 |  | |
| django__django-11087 | test-failed | art-nohints2 | 1742s | 28 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11087-VQciWb/repo/.swe-bench-venv/bi | |
| django__django-11138 | test-failed | art-400-debug | 635s | 170 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11138-M1m6Qg/repo/.swe-bench-venv/bi | |
| django__django-11141 | test-failed | art3 | 217s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11141-maXjfB/repo/.swe-bench-venv/bi | |
| django__django-11265 | unknown | artb1n | 1815s | - |  | |
| django__django-11400 | test-failed | art-nohints1 | 395s | 34 |  | |
| django__django-11532 | test-failed | art-b1-nopatch2 | 1352s | 16 |  | |
| django__django-11734 | test-failed | art3 | 619s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-11734-TqSvX8/repo/.swe-bench-venv/bi | |
| django__django-11749 | test-failed | art-rerun22 | 618s | 34 |  | |
| django__django-11790 | test-failed | art3 | 363s | 16 |  | |
| django__django-11820 | test-failed | art-nohints1 | 756s | 17 |  | |
| django__django-12209 | unknown | art-12209 | 1827s | - |  | |
| django__django-12273 | test-failed | art-b1-nopatch2 | 1358s | 18 |  | |
| django__django-12308 | test-failed | art-nohints1 | 365s | 17 |  | |
| django__django-12325 | test-failed | art-rerun22 | 291s | 20 |  | |
| django__django-12406 | test-failed | art-nohints1 | 389s | 25 |  | |
| django__django-12663 | unknown | art-nohints1 | 1829s | - |  | |
| django__django-12774 | test-failed | art-b1-nopatch2 | 207s | 38 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-12774-5vlPeP/repo/.swe-bench-venv/bi | |
| django__django-13128 | transport-loss | art-400-debug | 333s | - |  | |
| django__django-13158 | transport-loss | art-b1-nopatch2 | 356s | - | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13158-2efn7f/repo/.swe-bench-venv/bi | |
| django__django-13195 | test-failed | art-rerun22 | 302s | 45 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13195-i5Cwgw/repo/.swe-bench-venv/bi | |
| django__django-13212 | test-failed | art-b1-nopatch2 | 390s | 144 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13212-utLTBn/repo/.swe-bench-venv/bi | |
| django__django-13401 | test-failed | art3 | 375s | 37 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13401-DLznQ5/repo/.swe-bench-venv/bi | |
| django__django-13512 | test-failed | art-b1-nopatch2 | 178s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13512-80KYqi/repo/.swe-bench-venv/bi | |
| django__django-13513 | no-diff | art-b1-nopatch2 | 668s | - | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-13513-NBHEYg/repo/.swe-bench-venv/bi | |
| django__django-13794 | test-failed | art-b2-testfailed | 286s | 24 |  | |
| django__django-14011 | test-failed | art-b2-testfailed | 866s | 60 |  | |
| django__django-14017 | unknown | art-nohints1 | 1827s | - |  | |
| django__django-14034 | test-failed | art-b2-testfailed | 643s | 19 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14034-DEt2YO/repo/.swe-bench-venv/bi | |
| django__django-14140 | test-failed | art-b2-testfailed | 145s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14140-ExOK9E/repo/.swe-bench-venv/bi | |
| django__django-14155 | test-failed | art-b2-testfailed | 407s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14155-FE6y5B/repo/.swe-bench-venv/bi | |
| django__django-14170 | test-failed | artb2 | 382s | 33 |  | |
| django__django-14315 | test-failed | art-b2-testfailed | 203s | 13 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14315-7azV7I/repo/.swe-bench-venv/bi | |
| django__django-14349 | test-failed | art-b2-testfailed | 244s | 22 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14349-T16kbU/repo/.swe-bench-venv/bi | |
| django__django-14351 | no-diff | art-nohints1 | 1819s | - |  | |
| django__django-14376 | test-failed | art-b2-testfailed | 204s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-14376-qI9x2J/repo/.swe-bench-venv/bi | |
| django__django-14559 | test-failed | art-nohints1 | 131s | 30 |  | |
| django__django-14725 | test-failed | art-nohints1 | 686s | 167 |  | |
| django__django-14771 | test-failed | artb2 | 186s | 28 |  | |
| django__django-15022 | test-failed | artb2 | 1414s | 95 |  | |
| django__django-15098 | unknown | art-nohints1 | 1822s | - |  | |
| django__django-15127 | test-failed | art-b2-testfailed | 190s | 14 |  | |
| django__django-15252 | test-failed | artb2 | 1639s | 39 |  | |
| django__django-15629 | test-failed | art-b2-testfailed | 900s | 50 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-15629-C9hdf6/repo/.swe-bench-venv/bi | |
| django__django-15732 | test-failed | art-b2-testfailed | 545s | 17 |  | |
| django__django-15916 | test-failed | artb2 | 201s | 16 |  | |
| django__django-16256 | test-failed | artb2 | 484s | 95 |  | |
| django__django-16454 | test-failed | art-b2-testfailed | 1206s | 30 |  | |
| django__django-16485 | test-failed | artb2 | 414s | 14 |  | |
| django__django-16493 | test-failed | art-b2-testfailed | 198s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16493-PeU6NU/repo/.swe-bench-venv/bi | |
| django__django-16502 | test-failed | artb2 | 908s | 56 |  | |
| django__django-16527 | test-failed | artb2 | 268s | 13 |  | |
| django__django-16560 | test-failed | artb2 | 772s | 364 |  | |
| django__django-16569 | test-failed | art-b2-testfailed | 181s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16569-kj4R4k/repo/.swe-bench-venv/bi | |
| django__django-16595 | test-failed | artb2 | 189s | 18 |  | |
| django__django-16612 | test-failed | artb2 | 318s | 16 |  | |
| django__django-16631 | test-failed | art-b2-testfailed | 632s | 93 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16631-VBGEdC/repo/.swe-bench-venv/bi | |
| django__django-16642 | test-failed | art-b2-testfailed | 640s | 22 |  | |
| django__django-16661 | test-failed | art-b2-testfailed | 845s | 32 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16661-KMsLS4/repo/.swe-bench-venv/bi | |
| django__django-16662 | test-failed | artb2 | 315s | 19 |  | |
| django__django-16667 | test-failed | artb2 | 140s | 14 |  | |
| django__django-16801 | test-failed | artb2 | 208s | 15 |  | |
| django__django-16819 | test-failed | artb2 | 1046s | 36 |  | |
| django__django-16877 | test-failed | art-b2-testfailed | 399s | 50 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16877-rF4Eid/repo/.swe-bench-venv/bi | |
| django__django-16899 | test-failed | artb2 | 438s | 20 |  | |
| django__django-16901 | test-failed | art-b2-testfailed | 679s | 21 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16901-3E8KmN/repo/.swe-bench-venv/bi | |
| django__django-16938 | test-failed | art-b2-testfailed | 425s | 37 |  | |
| django__django-16950 | test-failed | art-b2-testfailed | 1698s | 26 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-16950-qzG8tD/repo/.swe-bench-venv/bi | |
| django__django-17029 | test-failed | art-b2-testfailed | 518s | 13 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-17029-QFZg87/repo/.swe-bench-venv/bi | |
| django__django-17084 | test-failed | art-b2-testfailed | 1237s | 41 |  | |
| django__django-17087 | test-failed | art-b3 | 137s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-17087-I7qMkk/repo/.swe-bench-venv/bi | |
| django__django-7530 | test-failed | art-b3 | 652s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-django__django-7530-61gYqz/repo/.swe-bench-venv/bin | |
| matplotlib__matplotlib-13989 | test-failed | art-b3 | 866s | 36 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-13989-8mFGjq/repo/.swe-bench | |
| matplotlib__matplotlib-14623 | test-failed | art-b3 | 1108s | 51 |  | |
| matplotlib__matplotlib-20488 | test-failed | art-b3 | 1106s | 19 |  | |
| matplotlib__matplotlib-20676 | env-blocked | art-b3 | 1164s | 19 |  | |
| matplotlib__matplotlib-20826 | env-blocked | art-b3 | 1062s | 21 |  | |
| matplotlib__matplotlib-20859 | test-failed | art-b3 | 3081s | 29 |  | |
| matplotlib__matplotlib-21568 | env-blocked | art-b3 | 919s | 19 |  | |
| matplotlib__matplotlib-22719 | test-failed | art-b3 | 669s | 23 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-22719-et5V9n/repo/.swe-bench | |
| matplotlib__matplotlib-22865 | test-failed | art-b3 | 775s | 23 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-22865-0wbCRx/repo/.swe-bench | |
| matplotlib__matplotlib-22871 | test-failed | art-b3 | 722s | 18 |  | |
| matplotlib__matplotlib-23299 | env-blocked | art-b3 | 1552s | 24 |  | |
| matplotlib__matplotlib-23314 | env-blocked | art-b3 | 656s | 14 |  | |
| matplotlib__matplotlib-23412 | test-failed | art-b3 | 697s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-23412-ICcL2A/repo/.swe-bench | |
| matplotlib__matplotlib-23476 | test-failed | art-b3 | 1114s | 37 |  | |
| matplotlib__matplotlib-24026 | env-blocked | art-b3 | 948s | 45 |  | |
| matplotlib__matplotlib-24149 | test-failed | art-b3 | 831s | 25 |  | |
| matplotlib__matplotlib-24177 | env-blocked | art-b3 | 678s | 14 |  | |
| matplotlib__matplotlib-24570 | test-failed | art-b3 | 742s | 18 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-24570-qQyFzd/repo/.swe-bench | |
| matplotlib__matplotlib-24627 | test-failed | art-b3 | 1378s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-24627-sQA3hF/repo/.swe-bench | |
| matplotlib__matplotlib-24637 | test-failed | art-b3 | 563s | 21 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-24637-LiQDrX/repo/.swe-bench | |
| matplotlib__matplotlib-24870 | test-failed | art-b3 | 1209s | 94 |  | |
| matplotlib__matplotlib-24970 | test-failed | art-b3 | 339s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-24970-HFTocs/repo/.swe-bench | |
| matplotlib__matplotlib-25122 | env-blocked | art-b3 | 738s | 33 |  | |
| matplotlib__matplotlib-25287 | test-failed | art-b3 | 1309s | 41 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-25287-MmY2Kh/repo/.swe-bench | |
| matplotlib__matplotlib-25311 | test-failed | art-b3 | 1349s | 70 |  | |
| matplotlib__matplotlib-25332 | test-failed | art-b3 | 1238s | 26 |  | |
| matplotlib__matplotlib-25479 | env-blocked | art-b3 | 866s | 20 |  | |
| matplotlib__matplotlib-25775 | test-failed | art-b3 | 1592s | 85 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-25775-A2ZL0b/repo/.swe-bench | |
| matplotlib__matplotlib-25960 | test-failed | art-b3 | 1179s | 65 |  | |
| matplotlib__matplotlib-26113 | test-failed | art-b3 | 993s | 23 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-matplotlib__matplotlib-26113-va6IhB/repo/.swe-bench | |
| matplotlib__matplotlib-26208 | transport-loss | art-b3 | 608s | - |  | |
| matplotlib__matplotlib-26291 | test-failed | art-b3 | 1386s | 14 |  | |
| matplotlib__matplotlib-26342 | test-failed | art-b3 | 1614s | 16 |  | |
| matplotlib__matplotlib-26466 | test-failed | art-b3 | 832s | 17 |  | |
| mwaskom__seaborn-3187 | test-failed | art-b3 | 1069s | 43 |  | |
| pallets__flask-5014 | test-failed | art-b3 | 279s | 27 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pallets__flask-5014-869daX/repo/.swe-bench-venv/bin | |
| psf__requests-1921 | test-failed | art-b3 | 313s | 14 |  | |
| psf__requests-2317 | test-failed | art-b3 | 235s | 23 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-2317-mhGmtD/repo/.swe-bench-venv/bin/ | |
| psf__requests-2931 | test-failed | art-b3 | 130s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-2931-yAwMem/repo/.swe-bench-venv/bin/ | |
| psf__requests-5414 | test-failed | art-b3 | 725s | 14 |  | |
| psf__requests-6028 | test-failed | art-b3 | 395s | 15 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-psf__requests-6028-7p1Zaz/repo/.swe-bench-venv/bin/ | |
| pydata__xarray-2905 | test-failed | art-b3 | 307s | 15 |  | |
| pydata__xarray-3095 | test-failed | art-b3 | 227s | 15 |  | |
| pydata__xarray-3151 | test-failed | art-b3 | 194s | 27 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3151-Ej4MdQ/repo/.swe-bench-venv/bin | |
| pydata__xarray-3305 | test-failed | art-b3 | 440s | 53 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3305-zyrWSC/repo/.swe-bench-venv/bin | |
| pydata__xarray-3677 | test-failed | art-b3 | 579s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-3677-0MLHtu/repo/.swe-bench-venv/bin | |
| pydata__xarray-3993 | test-failed | art-b3 | 511s | 115 |  | |
| pydata__xarray-4075 | test-failed | art-b3 | 366s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4075-G7BS4F/repo/.swe-bench-venv/bin | |
| pydata__xarray-4094 | test-failed | art-b3 | 916s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4094-rzZn8p/repo/.swe-bench-venv/bin | |
| pydata__xarray-4356 | test-failed | art-b3 | 600s | 21 |  | |
| pydata__xarray-4687 | test-failed | art-b3 | 527s | 48 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4687-1KvrRk/repo/.swe-bench-venv/bin | |
| pydata__xarray-4695 | test-failed | art-b3 | 149s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4695-9ocrL5/repo/.swe-bench-venv/bin | |
| pydata__xarray-4966 | test-failed | art-b3 | 499s | 20 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-4966-D87G6f/repo/.swe-bench-venv/bin | |
| pydata__xarray-6461 | test-failed | art-b3 | 520s | 104 |  | |
| pydata__xarray-6599 | test-failed | art-b3 | 178s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6599-KBQ9qA/repo/.swe-bench-venv/bin | |
| pydata__xarray-6721 | test-failed | art-b3 | 316s | 30 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6721-MY5Dko/repo/.swe-bench-venv/bin | |
| pydata__xarray-6744 | test-failed | art-b3 | 205s | 26 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6744-inWhCZ/repo/.swe-bench-venv/bin | |
| pydata__xarray-6938 | test-failed | art-b3 | 419s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6938-hA37iS/repo/.swe-bench-venv/bin | |
| pydata__xarray-6992 | test-failed | art-b3 | 443s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-6992-9FzmtP/repo/.swe-bench-venv/bin | |
| pydata__xarray-7229 | test-failed | art-b3 | 655s | 82 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-7229-iRTiOe/repo/.swe-bench-venv/bin | |
| pydata__xarray-7233 | test-failed | art-b3 | 383s | 14 |  | |
| pydata__xarray-7393 | test-failed | art-b3 | 200s | 19 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pydata__xarray-7393-rXQkDf/repo/.swe-bench-venv/bin | |
| pylint-dev__pylint-4551 | transport-loss | art-b3 | 224s | - |  | |
| pylint-dev__pylint-4604 | test-failed | art-b3 | 441s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-4604-ffXHxW/repo/.swe-bench-venv | |
| pylint-dev__pylint-4661 | test-failed | art-b3 | 540s | 92 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-4661-C1dV6m/repo/.swe-bench-venv | |
| pylint-dev__pylint-6528 | test-failed | art-b3 | 1094s | 103 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-6528-VOgpAG/repo/.swe-bench-venv | |
| pylint-dev__pylint-6903 | test-failed | art-b3 | 831s | 36 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-6903-UVIlpc/repo/.swe-bench-venv | |
| pylint-dev__pylint-7080 | test-failed | art-b3 | 851s | 13 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-7080-mrRNww/repo/.swe-bench-venv | |
| pylint-dev__pylint-7277 | test-failed | art-b3 | 419s | 18 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-7277-HH6dOh/repo/.swe-bench-venv | |
| pylint-dev__pylint-8898 | test-failed | art-b3 | 690s | 77 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pylint-dev__pylint-8898-lzm2Ba/repo/.swe-bench-venv | |
| pytest-dev__pytest-10051 | test-failed | art-b3 | 415s | 15 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-10051-bzZaxT/repo/.swe-bench-ven | |
| pytest-dev__pytest-10081 | test-failed | art-b3 | 707s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-10081-2P5kDg/repo/.swe-bench-ven | |
| pytest-dev__pytest-10356 | test-failed | art-b3 | 855s | 53 |  | |
| pytest-dev__pytest-5262 | test-failed | art-b3 | 372s | 16 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5262-f3tlox/repo/.swe-bench-venv | |
| pytest-dev__pytest-5631 | test-failed | art-b3 | 369s | 18 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5631-9e8zsg/repo/.swe-bench-venv | |
| pytest-dev__pytest-5787 | test-failed | art-b3 | 1137s | 180 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5787-hE7qZj/repo/.swe-bench-venv | |
| pytest-dev__pytest-5809 | test-failed | art-b3 | 353s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5809-psVbr7/repo/.swe-bench-venv | |
| pytest-dev__pytest-5840 | test-failed | art-b3 | 856s | 22 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-5840-bmHnWu/repo/.swe-bench-venv | |
| pytest-dev__pytest-6197 | test-failed | art-b3 | 1072s | 56 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-6197-ly7UHi/repo/.swe-bench-venv | |
| pytest-dev__pytest-6202 | test-failed | art-b3 | 584s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-6202-6zxfbt/repo/.swe-bench-venv | |
| pytest-dev__pytest-7205 | test-failed | art-b3 | 382s | 22 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7205-L3IdJT/repo/.swe-bench-venv | |
| pytest-dev__pytest-7236 | test-failed | art-b3 | 1505s | 17 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7236-rwOYbZ/repo/.swe-bench-venv | |
| pytest-dev__pytest-7324 | test-failed | art-b3 | 412s | 36 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7324-89lYNR/repo/.swe-bench-venv | |
| pytest-dev__pytest-7432 | test-failed | art-b3 | 361s | 66 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7432-C1DvLj/repo/.swe-bench-venv | |
| pytest-dev__pytest-7490 | test-failed | art-b3 | 647s | 20 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7490-tKeJkb/repo/.swe-bench-venv | |
| pytest-dev__pytest-7521 | test-failed | art-b3 | 345s | 13 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7521-S2kjk0/repo/.swe-bench-venv | |
| pytest-dev__pytest-7571 | test-failed | art-b3 | 439s | 33 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7571-eswYh5/repo/.swe-bench-venv | |
| pytest-dev__pytest-7982 | test-failed | art-b3 | 458s | 14 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-7982-mnxMMz/repo/.swe-bench-venv | |
| pytest-dev__pytest-8399 | test-failed | art-b3 | 735s | 54 | /var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe-bench-pytest-dev__pytest-8399-XE6zuN/repo/.swe-bench-venv | |
| scikit-learn__scikit-learn-10297 | test-failed | art-b3 | 625s | 32 |  | |
| scikit-learn__scikit-learn-10844 | test-failed | art-b3 | 566s | 14 |  | |
| scikit-learn__scikit-learn-10908 | test-failed | art-b3 | 674s | 25 |  | |
| scikit-learn__scikit-learn-11310 | test-failed | art-b3 | 727s | 54 |  | |
| scikit-learn__scikit-learn-11578 | test-failed | art-b3 | 773s | 15 |  | |
| scikit-learn__scikit-learn-12585 | test-failed | art-b3 | 802s | 14 |  | |
| scikit-learn__scikit-learn-12682 | no-diff | art-b3 | 139s | - |  | |
| scikit-learn__scikit-learn-12973 | test-failed | art-b3 | 684s | 39 |  | |
| scikit-learn__scikit-learn-13124 | test-failed | art-b3 | 880s | 30 |  | |
| scikit-learn__scikit-learn-13135 | test-failed | art-b3 | 542s | 14 |  | |
| scikit-learn__scikit-learn-13142 | test-failed | art-b3 | 630s | 33 |  | |
| scikit-learn__scikit-learn-13328 | env-blocked | art-b3 | 505s | 15 |  | |
| scikit-learn__scikit-learn-13439 | env-blocked | art-b3 | 539s | 16 |  | |
| scikit-learn__scikit-learn-13496 | other | art-b3 | - | - |  | |
| scikit-learn__scikit-learn-13779 | env-blocked | art-b3 | 357s | 15 |  | |
| scikit-learn__scikit-learn-14053 | env-blocked | art-b3 | 360s | 19 |  | |
| scikit-learn__scikit-learn-14087 | env-blocked | art-b3 | 696s | 36 |  | |
| scikit-learn__scikit-learn-14141 | env-blocked | art-b3 | 344s | 13 |  | |
| scikit-learn__scikit-learn-14496 | env-blocked | art-b3 | 695s | 62 |  | |
| scikit-learn__scikit-learn-14629 | env-blocked | art-b3 | 420s | 17 |  | |
| scikit-learn__scikit-learn-14710 | env-blocked | art-b3 | 398s | 21 |  | |
| scikit-learn__scikit-learn-14894 | env-blocked | art-b3 | 457s | 30 |  | |
| scikit-learn__scikit-learn-14983 | env-blocked | art-b3 | 487s | 17 |  | |
| scikit-learn__scikit-learn-15100 | env-blocked | art-b3 | 296s | 17 |  | |
| scikit-learn__scikit-learn-25102 | test-failed | art-b3 | 1510s | 123 |  | |
| scikit-learn__scikit-learn-25232 | test-failed | art-b3 | 1822s | 89 |  | |

## By repo
- django: 73
- matplotlib: 34
- scikit-learn: 26
- astropy: 22
- pydata: 21
- pytest-dev: 19
- pylint-dev: 8
- psf: 5
- mwaskom: 1
- pallets: 1
