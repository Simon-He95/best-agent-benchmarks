# Benchmark Progress Ledger

- Generated: 2026-08-19T11:20:22.915Z
- Tasks tracked: 375

## Summary by state

| State | Count |
|-------|-------|
| resolved | 164 |
| test-failed | 117 |
| no-diff | 22 |
| transport-loss | 8 |
| env-blocked | 53 |
| other | 5 |
| unknown | 6 |

## Per-task ledger (instance_id, batch, state, failing test)

| instance_id | batch | state | patchLines | failing test |
|-------------|-------|-------|------------|--------------|
| astropy__astropy-12907 | b1-nopatch | env-blocked | 14 |  |
| astropy__astropy-13033 | astropyenv | env-blocked | 39 |  |
| astropy__astropy-13236 | b1-nopatch | env-blocked | 42 |  |
| astropy__astropy-13398 | b1-nopatch | unknown | - |  |
| astropy__astropy-13453 | rerun23 | env-blocked | 31 |  |
| astropy__astropy-13579 | astropyenv | env-blocked | 58 |  |
| astropy__astropy-13977 | astropyenv | no-diff | - |  |
| astropy__astropy-14096 | b1-nopatch | env-blocked | 67 |  |
| astropy__astropy-14182 | astropyenv | no-diff | - |  |
| astropy__astropy-14309 | b1-nopatch | env-blocked | 44 |  |
| astropy__astropy-14365 | b1-nopatch | env-blocked | 16 |  |
| astropy__astropy-14369 | b1-nopatch | env-blocked | 115 |  |
| astropy__astropy-14508 | rerun23 | other | - |  |
| astropy__astropy-14539 | b1-nopatch | env-blocked | 14 |  |
| astropy__astropy-14598 | b1-nopatch | env-blocked | 40 |  |
| astropy__astropy-14995 | b1-nopatch | env-blocked | 14 |  |
| astropy__astropy-7166 | rerun23 | other | - |  |
| astropy__astropy-7336 | rerun23 | test-failed | 15 |  |
| astropy__astropy-7606 | b1-nopatch | env-blocked | 21 |  |
| astropy__astropy-7671 | astropyenv | env-blocked | 31 |  |
| astropy__astropy-8707 | astropyenv | no-diff | - |  |
| astropy__astropy-8872 | astropyenv | env-blocked | 23 |  |
| django__django-10097 | b1-rerun | resolved | 14 |  |
| django__django-10554 | nohints2 | transport-loss | - |  |
| django__django-10880 | nohints2 | resolved | 14 |  |
| django__django-10914 | nohints2 | resolved | 66 |  |
| django__django-10973 | b1-reeval | resolved | 68 |  |
| django__django-10999 | nohints2 | test-failed | 14 | test_negative (utils_tests.test_dateparse.DurationParseTests |
| django__django-11066 | nohints2 | resolved | 14 |  |
| django__django-11087 | nohints2 | test-failed | 28 | test_only_referenced_fields_selected (delete.tests.DeletionT |
| django__django-11095 | nohints2 | resolved | 65 |  |
| django__django-11099 | b1-reeval | resolved | 23 |  |
| django__django-11119 | nohints2 | resolved | 14 |  |
| django__django-11133 | nohints2 | resolved | 23 |  |
| django__django-11138 | 400-debug | test-failed | 170 | test_query_convert_timezones (timezones.tests.NewDatabaseTes |
| django__django-11141 | b1-rerun-final | test-failed | 17 | test_load_empty_dir (migrations.test_loader.LoaderTests) |
| django__django-11149 | nohints2 | resolved | 84 |  |
| django__django-11163 | nohints2 | resolved | 14 |  |
| django__django-11179 | nohints2 | resolved | 13 |  |
| django__django-11206 | nohints2 | resolved | 19 |  |
| django__django-11211 | nohints2 | resolved | 14 |  |
| django__django-11239 | b1-reeval | resolved | 34 |  |
| django__django-11265 | b1-nopatch | unknown | - |  |
| django__django-11276 | b1-reeval | resolved | 36 |  |
| django__django-11292 | b1-rerun | resolved | 52 |  |
| django__django-11299 | nohints2 | resolved | 14 |  |
| django__django-11333 | nohints2 | resolved | 43 |  |
| django__django-11400 | nohints2 | test-failed | 34 | test_get_choices_default_ordering (model_fields.tests.GetCho |
| django__django-11433 | b1-reeval | resolved | 15 |  |
| django__django-11451 | b1-reeval | resolved | 14 |  |
| django__django-11477 | nohints2 | resolved | 13 |  |
| django__django-11490 | b1-reeval | resolved | 13 |  |
| django__django-11532 | b1-nopatch | test-failed | 16 | test_non_ascii_dns_non_unicode_email (mail.tests.MailTests) |
| django__django-11551 | nohints2 | resolved | 58 |  |
| django__django-11555 | nohints2 | resolved | 24 |  |
| django__django-11603 | nohints2 | resolved | 35 |  |
| django__django-11728 | nohints2 | resolved | 29 |  |
| django__django-11734 | b1-rerun-final | test-failed | 16 | test_subquery_exclude_outerref (queries.tests.ExcludeTests) |
| django__django-11740 | nohints2 | resolved | 33 |  |
| django__django-11749 | rerun23 | test-failed | 70 | test_subparser_invalid_option (user_commands.tests.CommandTe |
| django__django-11790 | stat-rerun | test-failed | 16 | test_username_field_max_length_defaults_to_254 (auth_tests.t |
| django__django-11815 | nohints2 | resolved | 19 |  |
| django__django-11820 | nohints2 | test-failed | 17 | test_ordering_pointing_multiple_times_to_model_fields (inval |
| django__django-11848 | nohints2 | resolved | 22 |  |
| django__django-11880 | nohints2 | resolved | 13 |  |
| django__django-11885 | 400-debug | resolved | 180 |  |
| django__django-11951 | b1-reeval | resolved | 15 |  |
| django__django-11964 | nohints2 | resolved | 20 |  |
| django__django-11999 | nohints2 | resolved | 21 |  |
| django__django-12039 | nohints2 | resolved | 33 |  |
| django__django-12050 | b1-reeval | resolved | 14 |  |
| django__django-12125 | nohints2 | resolved | 14 |  |
| django__django-12143 | b1-reeval | resolved | 14 |  |
| django__django-12155 | nohints2 | resolved | 17 |  |
| django__django-12193 | nohints2 | resolved | 16 |  |
| django__django-12209 | nohints2 | unknown | - |  |
| django__django-12262 | b1-reeval | resolved | 26 |  |
| django__django-12273 | b1-nopatch | test-failed | 18 | test_create_new_instance_with_pk_equals_none (model_inherita |
| django__django-12276 | nohints2 | resolved | 25 |  |
| django__django-12304 | b1-rerun | resolved | 14 |  |
| django__django-12308 | nohints2 | test-failed | 17 | test_json_display_for_field (admin_utils.tests.UtilsTests) ( |
| django__django-12325 | rerun23 | test-failed | 31 | test_clash_parent_link (invalid_models_tests.test_relative_f |
| django__django-12406 | nohints2 | test-failed | 25 | test_choices_radio_blank (model_forms.test_modelchoicefield. |
| django__django-12419 | nohints2 | resolved | 88 |  |
| django__django-12663 | nohints2 | unknown | - |  |
| django__django-12708 | nohints2 | resolved | 16 |  |
| django__django-12713 | b1-reeval | resolved | 33 |  |
| django__django-12741 | b1-reeval | resolved | 30 |  |
| django__django-12754 | nohints2 | resolved | 21 |  |
| django__django-12774 | b1-nopatch | test-failed | 38 | test_in_bulk_non_unique_meta_constaint (lookup.tests.LookupT |
| django__django-12858 | b1-nopatch | resolved | 16 |  |
| django__django-12965 | nohints2 | resolved | 14 |  |
| django__django-13012 | nohints2 | resolved | 19 |  |
| django__django-13023 | b1-nopatch | resolved | 14 |  |
| django__django-13028 | nohints2 | resolved | 23 |  |
| django__django-13033 | nohints2 | resolved | 14 |  |
| django__django-13089 | b1-nopatch | resolved | 22 |  |
| django__django-13109 | nohints2 | resolved | 14 |  |
| django__django-13112 | nohints2 | resolved | 19 |  |
| django__django-13121 | nohints2 | resolved | 77 |  |
| django__django-13128 | 400-debug | transport-loss | - |  |
| django__django-13158 | b1-nopatch | transport-loss | - |  |
| django__django-13195 | rerun23 | test-failed | 62 | test_session_delete_on_end (sessions_tests.tests.SessionMidd |
| django__django-13212 | b1-nopatch | test-failed | 144 | test_value_placeholder_with_file_field (forms_tests.tests.te |
| django__django-13279 | b1-nopatch | resolved | 27 |  |
| django__django-13297 | nohints2 | resolved | 53 |  |
| django__django-13315 | nohints2 | resolved | 14 |  |
| django__django-13343 | b1-reeval | resolved | 26 |  |
| django__django-13344 | nohints2 | resolved | 50 |  |
| django__django-13346 | nohints2 | resolved | 42 |  |
| django__django-13363 | nohints2 | resolved | 23 |  |
| django__django-13401 | b1-rerun-final | test-failed | 37 | test_abstract_inherited_fields (model_fields.tests.BasicFiel |
| django__django-13406 | nohints2 | resolved | 14 |  |
| django__django-13410 | nohints2 | resolved | 25 |  |
| django__django-13417 | nohints2 | resolved | 18 |  |
| django__django-13449 | nohints2 | resolved | 31 |  |
| django__django-13512 | b1-nopatch | test-failed | 14 | test_json_display_for_field (admin_utils.tests.UtilsTests) ( |
| django__django-13513 | b1-nopatch | no-diff | - |  |
| django__django-13516 | stat-rerun | resolved | 15 |  |
| django__django-13551 | b1-nopatch | resolved | 29 |  |
| django__django-13568 | b1-nopatch | resolved | 18 |  |
| django__django-13569 | nohints2 | resolved | 17 |  |
| django__django-13590 | b1-nopatch | resolved | 23 |  |
| django__django-13658 | nohints2 | resolved | 19 |  |
| django__django-13670 | b1-reeval | resolved | 14 |  |
| django__django-13741 | nohints2 | resolved | 43 |  |
| django__django-13786 | nohints2 | resolved | 22 |  |
| django__django-13794 | nohints2 | test-failed | 24 | test_lazy_add (utils_tests.test_functional.FunctionalTests) |
| django__django-13807 | nohints2 | resolved | 32 |  |
| django__django-13809 | nohints2 | resolved | 46 |  |
| django__django-13810 | nohints2 | resolved | 19 |  |
| django__django-13820 | b2 | resolved | 16 |  |
| django__django-13821 | b2 | resolved | 74 |  |
| django__django-13837 | b2 | resolved | 23 |  |
| django__django-13925 | nohints2 | resolved | 15 |  |
| django__django-13933 | nohints2 | resolved | 29 |  |
| django__django-13964 | nohints2 | resolved | 20 |  |
| django__django-14007 | b2 | resolved | 31 |  |
| django__django-14011 | b2-testfailed | test-failed | 60 |  |
| django__django-14017 | nohints2 | unknown | - |  |
| django__django-14034 | b2-testfailed | test-failed | 19 | test_render_required_attributes (forms_tests.field_tests.tes |
| django__django-14053 | nohints2 | resolved | 51 |  |
| django__django-14089 | b2 | resolved | 15 |  |
| django__django-14122 | b2 | resolved | 20 |  |
| django__django-14140 | b2-testfailed | test-failed | 17 | test_deconstruct (queries.test_q.QTests.test_deconstruct) |
| django__django-14155 | b2-testfailed | test-failed | 14 | test_repr (urlpatterns_reverse.tests.ResolverMatchTests.test |
| django__django-14170 | stat-rerun2 | test-failed | 33 | test_extract_year_greaterthan_lookup (db_functions.datetime. |
| django__django-14238 | b2 | resolved | 14 |  |
| django__django-14311 | nohints2 | resolved | 22 |  |
| django__django-14315 | b2-testfailed | test-failed | 13 | test_runshell_use_environ (backends.base.test_client.SimpleD |
| django__django-14349 | b2-testfailed | test-failed | 22 | test_validators (validators.tests.TestValidators.test_valida |
| django__django-14351 | nohints2 | no-diff | - |  |
| django__django-14373 | b2 | resolved | 16 |  |
| django__django-14376 | b2-testfailed | test-failed | 17 | test_options_non_deprecated_keys_preferred (dbshell.test_mys |
| django__django-14404 | b2 | resolved | 15 |  |
| django__django-14434 | b2 | resolved | 16 |  |
| django__django-14493 | nohints2 | resolved | 13 |  |
| django__django-14500 | nohints2 | resolved | 15 |  |
| django__django-14534 | nohints2 | resolved | 14 |  |
| django__django-14539 | nohints2 | resolved | 25 |  |
| django__django-14559 | nohints2 | test-failed | 30 | test_empty_objects (queries.test_bulk_update.BulkUpdateTests |
| django__django-14580 | nohints2 | resolved | 14 |  |
| django__django-14608 | nohints2 | resolved | 46 |  |
| django__django-14631 | nohints2 | resolved | 99 |  |
| django__django-14672 | stat-rerun2 | resolved | 14 |  |
| django__django-14725 | nohints2 | test-failed | 167 | test_edit_only (model_formsets.tests.ModelFormsetTest.test_e |
| django__django-14752 | nohints2 | resolved | 22 |  |
| django__django-14765 | nohints2 | resolved | 15 |  |
| django__django-14771 | stat-rerun2 | test-failed | 28 | test_xoptions (utils_tests.test_autoreload.TestChildArgument |
| django__django-14787 | b2-testfailed | resolved | 14 |  |
| django__django-14792 | nohints2 | resolved | 49 |  |
| django__django-14855 | nohints2 | resolved | 18 |  |
| django__django-14915 | nohints2 | resolved | 15 |  |
| django__django-14999 | b2 | resolved | 16 |  |
| django__django-15022 | stat-rerun2 | test-failed | 95 | test_many_search_terms (admin_changelist.tests.ChangeListTes |
| django__django-15037 | nohints2 | resolved | 20 |  |
| django__django-15098 | nohints2 | unknown | - |  |
| django__django-15103 | b2 | resolved | 58 |  |
| django__django-15104 | b2 | resolved | 14 |  |
| django__django-15127 | nohints2 | test-failed | 14 | test_override_settings_level_tags (messages_tests.tests.Test |
| django__django-15128 | nohints2 | resolved | 78 |  |
| django__django-15161 | nohints2 | resolved | 126 |  |
| django__django-15252 | stat-rerun2 | test-failed | 39 | test_migrate_test_setting_false_ensure_schema (backends.base |
| django__django-15268 | b2-testfailed | resolved | 22 |  |
| django__django-15277 | nohints2 | resolved | 15 |  |
| django__django-15278 | nohints2 | resolved | 17 |  |
| django__django-15280 | nohints2 | resolved | 27 |  |
| django__django-15315 | stat-rerun2 | resolved | 18 |  |
| django__django-15368 | nohints2 | resolved | 23 |  |
| django__django-15375 | nohints2 | resolved | 16 |  |
| django__django-15380 | stat-rerun2 | resolved | 14 |  |
| django__django-15382 | nohints2 | resolved | 35 |  |
| django__django-15467 | nohints2 | resolved | 16 |  |
| django__django-15499 | b2 | resolved | 25 |  |
| django__django-15503 | nohints2 | resolved | 76 |  |
| django__django-15525 | nohints2 | resolved | 16 |  |
| django__django-15554 | nohints2 | resolved | 119 |  |
| django__django-15561 | nohints2 | resolved | 13 |  |
| django__django-15563 | nohints2 | resolved | 58 |  |
| django__django-15569 | nohints2 | resolved | 13 |  |
| django__django-15572 | stat-rerun2 | resolved | 23 |  |
| django__django-15629 | b2-testfailed | test-failed | 50 |  |
| django__django-15695 | nohints2 | resolved | 15 |  |
| django__django-15731 | nohints2 | resolved | 23 |  |
| django__django-15732 | nohints2 | test-failed | 17 | test_remove_unique_together_on_unique_field (migrations.test |
| django__django-15741 | stat-rerun2 | resolved | 13 |  |
| django__django-15814 | nohints2 | resolved | 14 |  |
| django__django-15851 | b2 | resolved | 16 |  |
| django__django-15863 | stat-rerun2 | resolved | 23 |  |
| django__django-15916 | stat-rerun2 | test-failed | 16 | test_custom_callback_in_meta (model_forms.tests.FormFieldCal |
| django__django-15930 | nohints2 | resolved | 20 |  |
| django__django-15957 | nohints2 | resolved | 75 |  |
| django__django-15973 | nohints2 | resolved | 41 |  |
| django__django-15987 | b2-testfailed | resolved | 14 |  |
| django__django-16032 | rerun23 | other | - |  |
| django__django-16082 | nohints2 | resolved | 14 |  |
| django__django-16100 | nohints2 | resolved | 35 |  |
| django__django-16116 | nohints2 | resolved | 34 |  |
| django__django-16136 | nohints2 | resolved | 23 |  |
| django__django-16139 | b2 | resolved | 16 |  |
| django__django-16145 | nohints2 | resolved | 15 |  |
| django__django-16255 | nohints2 | resolved | 14 |  |
| django__django-16256 | stat-rerun2 | test-failed | 95 |  |
| django__django-16263 | nohints2 | resolved | 232 |  |
| django__django-16315 | nohints2 | resolved | 51 |  |
| django__django-16333 | b2 | resolved | 15 |  |
| django__django-16429 | nohints2 | resolved | 13 |  |
| django__django-16454 | rerun23 | test-failed | 29 | test_subparser_error_formatting (unittest.loader._FailedTest |
| django__django-16485 | stat-rerun2 | test-failed | 14 | test_zero_values (unittest.loader._FailedTest.test_zero_valu |
| django__django-16493 | b2-testfailed | test-failed | 17 | test_deconstruction (unittest.loader._FailedTest.test_decons |
| django__django-16502 | stat-rerun2 | test-failed | 56 | test_no_body_returned_for_head_requests (unittest.loader._Fa |
| django__django-16527 | stat-rerun2 | test-failed | 13 | test_submit_row_save_as_new_add_permission_required (unittes |
| django__django-16560 | stat-rerun2 | test-failed | 364 | test_custom_violation_code_message (unittest.loader._FailedT |
| django__django-16569 | b2-testfailed | test-failed | 16 | test_disable_delete_extra_formset_forms (unittest.loader._Fa |
| django__django-16595 | stat-rerun2 | test-failed | 18 | test_alter_alter_field (unittest.loader._FailedTest.test_alt |
| django__django-16612 | stat-rerun2 | test-failed | 16 | test_missing_slash_append_slash_true_query_string (unittest. |
| django__django-16631 | b2-testfailed | test-failed | 93 | test_get_user_fallback_secret (unittest.loader._FailedTest.t |
| django__django-16642 | rerun23 | other | - |  |
| django__django-16661 | b2-testfailed | test-failed | 32 | test_lookup_allowed_foreign_primary (unittest.loader._Failed |
| django__django-16662 | stat-rerun2 | test-failed | 19 | test_args_kwargs_signature (unittest.loader._FailedTest.test |
| django__django-16667 | stat-rerun2 | test-failed | 14 | test_form_field (unittest.loader._FailedTest.test_form_field |
| django__django-16801 | stat-rerun2 | test-failed | 15 | test_post_init_not_connected (unittest.loader._FailedTest.te |
| django__django-16819 | stat-rerun2 | test-failed | 36 | test_add_remove_index (unittest.loader._FailedTest.test_add_ |
| django__django-16877 | b2-testfailed | test-failed | 50 | test_autoescape_off (unittest.loader._FailedTest.test_autoes |
| django__django-16899 | stat-rerun2 | test-failed | 20 | test_nonexistent_field (unittest.loader._FailedTest.test_non |
| django__django-16901 | b2-testfailed | test-failed | 21 | test_filter_multiple (unittest.loader._FailedTest.test_filte |
| django__django-16938 | rerun23 | test-failed | 14 | test_serialize_no_only_pk_with_natural_keys (unittest.loader |
| django__django-16950 | b2-testfailed | test-failed | 26 | test_inlineformset_factory_ignores_default_pks_on_submit (mo |
| django__django-17029 | b2-testfailed | test-failed | 13 | test_clear_cache (unittest.loader._FailedTest.test_clear_cac |
| django__django-17084 | rerun23 | other | - |  |
| django__django-17087 | b3 | test-failed | 14 | test_serialize_nested_class_method (unittest.loader._FailedT |
| django__django-7530 | b3 | test-failed | 14 |  |
| django__django-9296 | b3 | resolved | 16 |  |
| matplotlib__matplotlib-13989 | b3 | test-failed | 36 | not found: /private/var/folders/df/djsxfhc17x95674wsm_g8s980 |
| matplotlib__matplotlib-14623 | b3 | env-blocked | 24 |  |
| matplotlib__matplotlib-20488 | b3 | env-blocked | 18 |  |
| matplotlib__matplotlib-20676 | b3 | no-diff | - |  |
| matplotlib__matplotlib-20826 | b3 | no-diff | - |  |
| matplotlib__matplotlib-20859 | b3 | env-blocked | 46 |  |
| matplotlib__matplotlib-21568 | b3 | transport-loss | - |  |
| matplotlib__matplotlib-22719 | b3 | test-failed | 23 | not found: /private/var/folders/df/djsxfhc17x95674wsm_g8s980 |
| matplotlib__matplotlib-22865 | b3 | test-failed | 23 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| matplotlib__matplotlib-22871 | b3 | transport-loss | - |  |
| matplotlib__matplotlib-23299 | b3 | transport-loss | - |  |
| matplotlib__matplotlib-23314 | b3 | no-diff | - |  |
| matplotlib__matplotlib-23412 | b3 | test-failed | 17 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| matplotlib__matplotlib-23476 | b3 | env-blocked | 14 |  |
| matplotlib__matplotlib-24026 | b3 | no-diff | - |  |
| matplotlib__matplotlib-24149 | b3 | env-blocked | 25 |  |
| matplotlib__matplotlib-24177 | b3 | env-blocked | 103 |  |
| matplotlib__matplotlib-24570 | b3 | test-failed | 18 |  |
| matplotlib__matplotlib-24627 | b3 | test-failed | 16 |  |
| matplotlib__matplotlib-24637 | b3 | test-failed | 21 |  |
| matplotlib__matplotlib-24870 | b3 | no-diff | - |  |
| matplotlib__matplotlib-24970 | b3 | test-failed | 16 |  |
| matplotlib__matplotlib-25122 | b3 | env-blocked | 33 |  |
| matplotlib__matplotlib-25287 | b3 | test-failed | 41 |  |
| matplotlib__matplotlib-25311 | b3 | transport-loss | - |  |
| matplotlib__matplotlib-25332 | b3 | no-diff | - |  |
| matplotlib__matplotlib-25479 | b3 | no-diff | - |  |
| matplotlib__matplotlib-25775 | b3 | test-failed | 85 |  |
| matplotlib__matplotlib-25960 | b3 | env-blocked | 43 |  |
| matplotlib__matplotlib-26113 | b3 | test-failed | 23 |  |
| matplotlib__matplotlib-26208 | b3 | env-blocked | 14 |  |
| matplotlib__matplotlib-26291 | b3 | env-blocked | 14 |  |
| matplotlib__matplotlib-26342 | b3 | env-blocked | 36 |  |
| matplotlib__matplotlib-26466 | b3 | env-blocked | 15 |  |
| mwaskom__seaborn-3069 | b3 | resolved | 48 |  |
| mwaskom__seaborn-3187 | b3 | no-diff | - |  |
| pallets__flask-5014 | b3 | test-failed | 27 |  |
| psf__requests-1142 | b3 | resolved | 25 |  |
| psf__requests-1724 | b3 | transport-loss | - |  |
| psf__requests-1766 | b3 | resolved | 14 |  |
| psf__requests-1921 | b3 | resolved | 32 |  |
| psf__requests-2317 | b3 | test-failed | 23 |  |
| psf__requests-2931 | b3 | test-failed | 14 |  |
| psf__requests-5414 | b3 | no-diff | - |  |
| psf__requests-6028 | b3 | test-failed | 15 |  |
| pydata__xarray-2905 | b3 | no-diff | - |  |
| pydata__xarray-3095 | b3 | no-diff | - |  |
| pydata__xarray-3151 | b3 | test-failed | 27 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pydata__xarray-3305 | b3 | test-failed | 53 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pydata__xarray-3677 | b3 | test-failed | 17 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pydata__xarray-3993 | b3 | no-diff | - |  |
| pydata__xarray-4075 | b3 | test-failed | 16 |  |
| pydata__xarray-4094 | b3 | test-failed | 14 |  |
| pydata__xarray-4356 | b3 | no-diff | - |  |
| pydata__xarray-4629 | b3 | resolved | 14 |  |
| pydata__xarray-4687 | b3 | test-failed | 48 |  |
| pydata__xarray-4695 | b3 | test-failed | 14 |  |
| pydata__xarray-4966 | b3 | test-failed | 20 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pydata__xarray-6461 | b3 | no-diff | - |  |
| pydata__xarray-6599 | b3 | test-failed | 16 |  |
| pydata__xarray-6721 | b3 | test-failed | 30 |  |
| pydata__xarray-6744 | b3 | test-failed | 26 |  |
| pydata__xarray-6938 | b3 | test-failed | 16 |  |
| pydata__xarray-6992 | b3 | test-failed | 14 |  |
| pydata__xarray-7229 | b3 | test-failed | 82 |  |
| pydata__xarray-7233 | b3 | no-diff | - |  |
| pydata__xarray-7393 | b3 | test-failed | 19 |  |
| pylint-dev__pylint-4551 | b3 | no-diff | - |  |
| pylint-dev__pylint-4604 | b3 | test-failed | 16 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-4661 | b3 | test-failed | 92 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-4970 | b3 | resolved | 14 |  |
| pylint-dev__pylint-6386 | b3 | resolved | 35 |  |
| pylint-dev__pylint-6528 | b3 | test-failed | 103 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-6903 | b3 | test-failed | 36 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-7080 | b3 | test-failed | 13 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-7277 | b3 | test-failed | 18 | found no collectors for /private/var/folders/df/djsxfhc17x95 |
| pylint-dev__pylint-8898 | b3 | test-failed | 77 | not found: /private/var/folders/df/djsxfhc17x95674wsm_g8s980 |
| pytest-dev__pytest-10051 | b3 | test-failed | 15 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-10081 | b3 | test-failed | 16 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-10356 | b3 | no-diff | - |  |
| pytest-dev__pytest-5262 | b3 | test-failed | 16 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-5631 | b3 | test-failed | 18 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-5787 | b3 | test-failed | 180 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-5809 | b3 | test-failed | 14 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-5840 | b3 | test-failed | 22 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-6197 | b3 | test-failed | 56 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-6202 | b3 | test-failed | 14 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7205 | b3 | test-failed | 22 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7236 | b3 | test-failed | 17 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7324 | b3 | test-failed | 36 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7432 | b3 | test-failed | 66 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7490 | b3 | test-failed | 20 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7521 | b3 | test-failed | 13 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7571 | b3 | test-failed | 33 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-7982 | b3 | test-failed | 14 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| pytest-dev__pytest-8399 | b3 | test-failed | 54 | /private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/swe |
| scikit-learn__scikit-learn-10297 | b3 | env-blocked | 32 |  |
| scikit-learn__scikit-learn-10844 | b3 | env-blocked | 15 |  |
| scikit-learn__scikit-learn-10908 | b3 | env-blocked | 27 |  |
| scikit-learn__scikit-learn-11310 | b3 | env-blocked | 106 |  |
| scikit-learn__scikit-learn-11578 | b3 | env-blocked | 15 |  |
| scikit-learn__scikit-learn-12585 | b3 | env-blocked | 24 |  |
| scikit-learn__scikit-learn-12682 | b3 | env-blocked | 150 |  |
| scikit-learn__scikit-learn-12973 | b3 | env-blocked | 38 |  |
| scikit-learn__scikit-learn-13124 | b3 | env-blocked | 38 |  |
| scikit-learn__scikit-learn-13135 | b3 | env-blocked | 14 |  |
| scikit-learn__scikit-learn-13142 | b3 | env-blocked | 29 |  |
| scikit-learn__scikit-learn-13328 | b3 | env-blocked | 15 |  |
| scikit-learn__scikit-learn-13439 | b3 | env-blocked | 27 |  |
| scikit-learn__scikit-learn-13496 | b3 | env-blocked | 68 |  |
| scikit-learn__scikit-learn-13779 | b3 | env-blocked | 15 |  |
| scikit-learn__scikit-learn-14053 | b3 | env-blocked | 29 |  |
| scikit-learn__scikit-learn-14087 | b3 | env-blocked | 29 |  |
| scikit-learn__scikit-learn-14141 | b3 | env-blocked | 13 |  |
| scikit-learn__scikit-learn-14496 | b3 | env-blocked | 55 |  |
| scikit-learn__scikit-learn-14629 | b3 | env-blocked | 31 |  |
| scikit-learn__scikit-learn-14710 | b3 | env-blocked | 21 |  |
| scikit-learn__scikit-learn-14894 | b3 | env-blocked | 27 |  |
| scikit-learn__scikit-learn-14983 | b3 | env-blocked | 27 |  |
| scikit-learn__scikit-learn-15100 | b3 | env-blocked | 17 |  |
| scikit-learn__scikit-learn-25102 | b3 | env-blocked | 114 |  |
| scikit-learn__scikit-learn-25232 | b3 | env-blocked | 72 |  |
