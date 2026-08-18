# SWE-bench Verified 500-task Final Report

- Generated: 2026-08-18T16:39:48.117Z
- Tasks tracked: 250

## Overall

| Metric | Value |
|--------|-------|
| **Resolved** | **173 / 250 (69.2%)** |

## Failure attribution

| Attribution | Count | Meaning |
|-------------|-------|---------|
| resolved | 173 |  |
| upstream-400 | 10 | relay/DeepSeek intermittent reasoning pass-back 400 — rerun usually passes |
| upstream-transport | 2 | ECONNRESET / Bad Gateway — upstream transient |
| env-blocked | 16 | evaluation environment could not build (astropy-era C/SDK issues) |
| no-diff | 1 | agent completed without editing (prompt behavior) |
| test-failed | 46 | MODEL CAPABILITY — patch present but tests fail |
| unknown | 2 | missing diagnostics |

## Remaining failures per task (model-capability candidates)

| instance_id | state | failing test | patch vs reference |
|-------------|-------|--------------|--------------------|
| astropy__astropy-13398 | unknown | ? | 异文件 (+0/202) |
| django__django-11138 | test-failed | test_query_convert_timezones (timezones.tests.NewDataba | 异文件 (+0/40) |
| django__django-11141 | test-failed | test_load_empty_dir (migrations.test_loader.LoaderTests | 异文件 (+0/4) |
| django__django-11265 | unknown | ? | 异文件 (+0/8) |
| django__django-11532 | test-failed | test_non_ascii_dns_non_unicode_email (mail.tests.MailTe | 异文件 (+0/16) |
| django__django-11734 | test-failed | test_subquery_exclude_outerref (queries.tests.ExcludeTe | 异文件 (+0/4) |
| django__django-11790 | test-failed | test_username_field_max_length_defaults_to_254 (auth_te | 异文件 (+0/3) |
| django__django-12273 | test-failed | test_create_new_instance_with_pk_equals_none (model_inh | 异文件 (+0/3) |
| django__django-12774 | test-failed | test_in_bulk_non_unique_meta_constaint (lookup.tests.Lo | 异文件 (+0/11) |
| django__django-13195 | test-failed | test_delete_cookie_secure_samesite_none (responses.test | 异文件 (+0/16) |
| django__django-13212 | test-failed | test_value_placeholder_with_file_field (forms_tests.tes | 异文件 (+0/19) |
| django__django-13401 | test-failed | test_abstract_inherited_fields (model_fields.tests.Basi | 异文件 (+0/23) |
| django__django-13512 | test-failed | test_json_display_for_field (admin_utils.tests.UtilsTes | 异文件 (+0/3) |
| django__django-13513 | no-diff | ? | 异文件 (+0/23) |
| django__django-14011 | test-failed | ? | 异文件 (+0/24) |
| django__django-14034 | test-failed | test_render_required_attributes (forms_tests.field_test | 异文件 (+0/12) |
| django__django-14140 | test-failed | test_deconstruct (queries.test_q.QTests.test_deconstruc | 异文件 (+0/4) |
| django__django-14155 | test-failed | test_repr (urlpatterns_reverse.tests.ResolverMatchTests | 异文件 (+0/10) |
| django__django-14170 | test-failed | test_extract_year_greaterthan_lookup (db_functions.date | 异文件 (+0/30) |
| django__django-14315 | test-failed | test_runshell_use_environ (backends.base.test_client.Si | 异文件 (+0/2) |
| django__django-14349 | test-failed | test_validators (validators.tests.TestValidators.test_v | 异文件 (+0/3) |
| django__django-14376 | test-failed | test_options_non_deprecated_keys_preferred (dbshell.tes | 异文件 (+0/8) |
| django__django-14771 | test-failed | test_xoptions (utils_tests.test_autoreload.TestChildArg | 异文件 (+0/5) |
| django__django-15022 | test-failed | test_many_search_terms (admin_changelist.tests.ChangeLi | 异文件 (+0/3) |
| django__django-15252 | test-failed | test_migrate_test_setting_false_ensure_schema (backends | 异文件 (+0/6) |
| django__django-15629 | test-failed | ? | 异文件 (+0/34) |
| django__django-15916 | test-failed | test_custom_callback_in_meta (model_forms.tests.FormFie | 异文件 (+0/3) |
| django__django-16256 | test-failed | ? | 异文件 (+0/55) |
| django__django-16454 | test-failed | test_subparser_error_formatting (unittest.loader._Faile | 异文件 (+0/10) |
| django__django-16485 | test-failed | test_zero_values (unittest.loader._FailedTest.test_zero | 异文件 (+0/1) |
| django__django-16493 | test-failed | test_deconstruction (unittest.loader._FailedTest.test_d | 异文件 (+0/3) |
| django__django-16502 | test-failed | test_no_body_returned_for_head_requests (unittest.loade | 异文件 (+0/26) |
| django__django-16527 | test-failed | test_submit_row_save_as_new_add_permission_required (un | 异文件 (+0/1) |
| django__django-16560 | test-failed | test_custom_violation_code_message (unittest.loader._Fa | 异文件 (+0/70) |
| django__django-16569 | test-failed | test_disable_delete_extra_formset_forms (unittest.loade | 异文件 (+0/3) |
| django__django-16595 | test-failed | test_alter_alter_field (unittest.loader._FailedTest.tes | 异文件 (+0/3) |
| django__django-16612 | test-failed | test_missing_slash_append_slash_true_query_string (unit | 异文件 (+0/3) |
| django__django-16631 | test-failed | test_get_user_fallback_secret (unittest.loader._FailedT | 异文件 (+0/28) |
| django__django-16642 | test-failed | test_content_disposition_buffer (unittest.loader._Faile | 异文件 (+0/2) |
| django__django-16661 | test-failed | test_lookup_allowed_foreign_primary (unittest.loader._F | 异文件 (+0/6) |
| django__django-16662 | test-failed | test_args_kwargs_signature (unittest.loader._FailedTest | 异文件 (+0/4) |
| django__django-16667 | test-failed | test_form_field (unittest.loader._FailedTest.test_form_ | 异文件 (+0/2) |
| django__django-16801 | test-failed | test_post_init_not_connected (unittest.loader._FailedTe | 异文件 (+0/4) |
| django__django-16819 | test-failed | test_add_remove_index (unittest.loader._FailedTest.test | 异文件 (+0/5) |
| django__django-16877 | test-failed | test_autoescape_off (unittest.loader._FailedTest.test_a | 异文件 (+0/10) |
| django__django-16899 | test-failed | test_nonexistent_field (unittest.loader._FailedTest.tes | 异文件 (+0/3) |
| django__django-16901 | test-failed | test_filter_multiple (unittest.loader._FailedTest.test_ | 异文件 (+0/6) |
| django__django-16950 | test-failed | test_inlineformset_factory_ignores_default_pks_on_submi | 异文件 (+0/7) |
| django__django-17029 | test-failed | test_clear_cache (unittest.loader._FailedTest.test_clea | 异文件 (+0/1) |
