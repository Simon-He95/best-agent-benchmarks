# Benchmark Failure Audit (semantic gap: gold test vs agent patch)

- Generated: 2026-08-21T02:37:01.912Z
- Real model failures audited: 239
- Source: gold `test_patch` assertions vs agent `agentPatch` (from `.tmp/art-*` fragments)

## Legend
- **gold asserts**: new/changed FAIL_TO_PASS assertions (the precise behavior the fix must satisfy)
- **agent files**: source files the agent modified
- **gap signal**: the agent patch misses the file/behavior the gold test exercises (or assertion values the agent likely got wrong)

## astropy__astropy-13033
- FAIL_TO_PASS: astropy/timeseries/tests/test_sampled.py::test_required_columns
- gold test files: astropy/timeseries/tests/test_sampled.py
- agent modified: astropy/timeseries/core.py
- gold asserts (0):

## astropy__astropy-13236
- FAIL_TO_PASS: astropy/table/tests/test_mixin.py::test_ndarray_mixin[False]; astropy/table/tests/test_table.py::test_structured_masked_column
- gold test files: astropy/table/tests/test_mixin.py, astropy/table/tests/test_table.py
- agent modified: astropy/table/__init__.py, astropy/table/table.py
- gold asserts (0):

## astropy__astropy-13398
- FAIL_TO_PASS: astropy/coordinates/tests/test_intermediate_transformations.py::test_itrs_topo_to_altaz_with_refraction; astropy/coordinates/tests/test_intermediate_transformations.py::test_itrs_topo_to_hadec_with_refraction; astropy/coordinates/tests/test_intermediate_transformations.py::test_cirs_itrs_topo; astropy/coordinates/tests/test_intermediate_transformations.py::test_itrs_straight_overhead
- gold test files: astropy/coordinates/tests/test_intermediate_transformations.py
- agent modified: CHANGES.rst, astropy/coordinates/builtin_frames/icrs_observed_transforms.py, astropy/coordinates/builtin_frames/utils.py
- gold asserts (0):

## astropy__astropy-14365
- FAIL_TO_PASS: astropy/io/ascii/tests/test_qdp.py::test_roundtrip[True]
- gold test files: astropy/io/ascii/tests/test_qdp.py
- agent modified: astropy/io/ascii/qdp.py
- gold asserts (0):

## astropy__astropy-14369
- FAIL_TO_PASS: astropy/units/tests/test_format.py::test_cds_grammar[strings4-unit4]; astropy/units/tests/test_format.py::test_cds_grammar[strings6-unit6]; astropy/units/tests/test_format.py::test_cds_grammar_fail[km/s.Mpc-1]
- gold test files: astropy/units/tests/test_format.py
- agent modified: CHANGES.rst, astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py
- gold asserts (0):

## astropy__astropy-14508
- FAIL_TO_PASS: astropy/io/fits/tests/test_header.py::TestHeaderFunctions::test_floating_point_string_representation_card
- gold test files: astropy/io/fits/tests/test_header.py
- agent modified: astropy/io/fits/card.py
- gold asserts (0):

## astropy__astropy-14598
- FAIL_TO_PASS: astropy/io/fits/tests/test_header.py::TestHeaderFunctions::test_long_string_value_with_quotes
- gold test files: astropy/io/fits/tests/test_header.py
- agent modified: CHANGES.rst, astropy/io/fits/card.py
- gold asserts (0):

## astropy__astropy-7166
- FAIL_TO_PASS: astropy/utils/tests/test_misc.py::test_inherit_docstrings
- gold test files: astropy/utils/tests/test_misc.py
- agent modified: astropy/utils/misc.py
- gold asserts (0):

## astropy__astropy-7336
- FAIL_TO_PASS: astropy/units/tests/test_quantity_annotations.py::test_return_annotation_none
- gold test files: astropy/units/tests/test_quantity_annotations.py, astropy/units/tests/test_quantity_decorator.py
- agent modified: CHANGES.rst, astropy/units/decorators.py
- gold asserts (0):

## astropy__astropy-7671
- FAIL_TO_PASS: astropy/utils/tests/test_introspection.py::test_minversion
- gold test files: astropy/utils/tests/test_introspection.py
- agent modified: astropy/utils/introspection.py
- gold asserts (0):

## django__django-10999
- FAIL_TO_PASS: test_negative (utils_tests.test_dateparse.DurationParseTests); test_parse_postgresql_format (utils_tests.test_dateparse.DurationParseTests)
- gold test files: tests/utils_tests/test_dateparse.py
- agent modified: django/utils/dateparse.py
- gold asserts (0):

## django__django-11141
- FAIL_TO_PASS: Migration directories without an __init__.py file are loaded.
- gold test files: tests/migrations/test_loader.py, tests/migrations/test_migrations_namespace_package/0001_initial.py
- agent modified: django/db/migrations/loader.py
- gold asserts (1):
  - `self.assertEqual(`

## django__django-11532
- FAIL_TO_PASS: test_non_ascii_dns_non_unicode_email (mail.tests.MailTests)
- gold test files: tests/mail/tests.py
- agent modified: django/core/mail/utils.py
- gold asserts (1):
  - `self.assertIn('@xn--p8s937b>', email.message()['Message-ID'])`

## django__django-11749
- FAIL_TO_PASS: test_mutually_exclusive_group_required_options (user_commands.tests.CommandTests)
- gold test files: tests/user_commands/management/commands/mutually_exclusive_required.py, tests/user_commands/tests.py
- agent modified: django/core/management/__init__.py
- gold asserts (3):
  - `self.assertIn('foo_id', out.getvalue())`
  - `self.assertIn('foo_name', out.getvalue())`
  - `with self.assertRaisesMessage(CommandError, msg):`

## django__django-11790
- FAIL_TO_PASS: test_username_field_max_length_defaults_to_254 (auth_tests.test_forms.AuthenticationFormTest); test_username_field_max_length_matches_user_model (auth_tests.test_forms.AuthenticationFormTest)
- gold test files: tests/auth_tests/test_forms.py
- agent modified: django/contrib/auth/forms.py
- gold asserts (2):
  - `self.assertEqual(form.fields['username'].widget.attrs.get('maxlength'), 255)`
  - `self.assertEqual(form.fields['username'].widget.attrs.get('maxlength'), 254)`

## django__django-11820
- FAIL_TO_PASS: test_ordering_pointing_multiple_times_to_model_fields (invalid_models_tests.test_models.OtherModelTests); test_ordering_pointing_to_related_model_pk (invalid_models_tests.test_models.OtherModelTests)
- gold test files: tests/invalid_models_tests/test_models.py
- agent modified: django/db/models/base.py
- gold asserts (2):
  - `self.assertEqual(Child.check(), [`
  - `self.assertEqual(Child.check(), [])`

## django__django-12273
- FAIL_TO_PASS: test_create_new_instance_with_pk_equals_none (model_inheritance_regress.tests.ModelInheritanceTest); test_create_new_instance_with_pk_equals_none_multi_inheritance (model_inheritance_regress.tests.ModelInheritanceTest)
- gold test files: tests/model_inheritance_regress/tests.py
- agent modified: django/db/models/base.py
- gold asserts (5):
  - `self.assertEqual(Profile.objects.count(), 2)`
  - `self.assertEqual(User.objects.get(pk=p1.user_ptr_id).username, 'john')`
  - `self.assertEqual(Congressman.objects.count(), 2)`
  - `self.assertEqual(Person.objects.get(pk=c1.pk).name, 'John')`
  - `self.assertEqual(`

## django__django-12325
- FAIL_TO_PASS: test_clash_parent_link (invalid_models_tests.test_relative_fields.ComplexClashTests); test_onetoone_with_parent_model (invalid_models_tests.test_models.OtherModelTests)
- gold test files: tests/invalid_models_tests/test_models.py, tests/invalid_models_tests/test_relative_fields.py, tests/migrations/test_state.py
- agent modified: django/db/models/base.py
- gold asserts (3):
  - `self.assertEqual(ParkingLot.check(), [])`
  - `self.assertEqual(ParkingLot.check(), [])`
  - `self.assertEqual(Child.check(), [`

## django__django-13195
- FAIL_TO_PASS: test_delete_cookie_samesite (responses.test_cookie.DeleteCookieTests); test_delete_cookie_secure_samesite_none (responses.test_cookie.DeleteCookieTests); test_session_delete_on_end (sessions_tests.tests.SessionMiddlewareTests); test_session_delete_on_end_with_custom_domain_and_path (sessions_tests.tests.SessionMiddlewareTests); test_cookie_setings (messages_tests.test_cookie.CookieTests)
- gold test files: tests/messages_tests/test_cookie.py, tests/responses/test_cookie.py, tests/sessions_tests/tests.py
- agent modified: django/contrib/messages/storage/cookie.py, django/http/response.py, docs/ref/request-response.txt, docs/releases/3.2.txt
- gold asserts (3):
  - `self.assertEqual(`
  - `self.assertEqual(cookie['samesite'], '')`
  - `self.assertEqual(response.cookies['c']['samesite'], 'lax')`

## django__django-13212
- FAIL_TO_PASS: test_value_placeholder_with_char_field (forms_tests.tests.test_validators.ValidatorCustomMessageTests); test_value_placeholder_with_decimal_field (forms_tests.tests.test_validators.ValidatorCustomMessageTests); test_value_placeholder_with_file_field (forms_tests.tests.test_validators.ValidatorCustomMessageTests); test_value_placeholder_with_integer_field (forms_tests.tests.test_validators.ValidatorCustomMessageTests); test_value_placeholder_with_null_character (forms_tests.tests.test_validators.ValidatorCustomMessageTests)
- gold test files: tests/forms_tests/tests/test_validators.py
- agent modified: django/core/validators.py
- gold asserts (5):
  - `self.assertEqual(form.errors, {'field': [value]})`
  - `self.assertEqual(form.errors, {'field': ['a\x00b']})`
  - `self.assertEqual(form.errors, {'field': [str(value)]})`
  - `self.assertEqual(form.errors, {'field': [value]})`
  - `self.assertEqual(form.errors, {'field': ['myfile.txt']})`

## django__django-13401
- FAIL_TO_PASS: Field instances from abstract models are not equal.
- gold test files: tests/model_fields/tests.py
- agent modified: django/db/models/fields/__init__.py
- gold asserts (0):

## django__django-14011
- FAIL_TO_PASS: test_live_server_url_is_class_property (servers.tests.LiveServerAddress); Data written to the database by a view can be read.; Fixtures are properly loaded and visible to the live server thread.; test_check_model_instance_from_subview (servers.tests.LiveServerThreadedTests); test_view_calls_subview (servers.tests.LiveServerThreadedTests); test_404 (servers.tests.LiveServerViews); A HTTP 1.1 server is supposed to support keep-alive. Since our; test_environ (servers.tests.LiveServerViews); test_keep_alive_connection_clears_previous_request_data (servers.tests.LiveServerViews); See `test_closes_connection_without_content_length` for details. This; test_media_files (servers.tests.LiveServerViews); LiveServerTestCase reports a 404 status code when HTTP client; Launched server serves with HTTP 1.1.; test_static_files (servers.tests.LiveServerViews); test_view (servers.tests.LiveServerViews); Each LiveServerTestCase binds to a unique port or fails to start a; LiveServerTestCase.port customizes the server's port.
- gold test files: django/test/testcases.py, tests/servers/tests.py
- agent modified: django/core/servers/basehttp.py, django/test/testcases.py
- gold asserts (3):
  - `self.assertIsNotNone(conn.connection)`
  - `self.assertEqual(f.read().splitlines(), [b'jane', b'robert'])`
  - `self.assertIsNone(conn.connection)`

## django__django-14034
- FAIL_TO_PASS: test_render_required_attributes (forms_tests.field_tests.test_multivaluefield.MultiValueFieldTest)
- gold test files: tests/forms_tests/field_tests/test_multivaluefield.py
- agent modified: django/forms/fields.py
- gold asserts (4):
  - `self.assertTrue(form.is_valid())`
  - `self.assertInHTML('<input type="text" name="f_0" value="Hello" required id="id_f_0">', form.as_p())`
  - `self.assertInHTML('<input type="text" name="f_1" id="id_f_1">', form.as_p())`
  - `self.assertFalse(form.is_valid())`

## django__django-14155
- FAIL_TO_PASS: test_repr (urlpatterns_reverse.tests.ResolverMatchTests); test_repr_functools_partial (urlpatterns_reverse.tests.ResolverMatchTests); test_resolver_match_on_request (urlpatterns_reverse.tests.ResolverMatchTests)
- gold test files: tests/urlpatterns_reverse/tests.py
- agent modified: django/urls/resolvers.py
- gold asserts (1):
  - `self.assertEqual(`

## django__django-14170
- FAIL_TO_PASS: test_extract_iso_year_func_boundaries (db_functions.datetime.test_extract_trunc.DateFunctionTests); test_extract_iso_year_func_boundaries (db_functions.datetime.test_extract_trunc.DateFunctionWithTimeZoneTests)
- gold test files: tests/db_functions/datetime/test_extract_trunc.py
- agent modified: django/db/models/lookups.py
- gold asserts (0):

## django__django-14315
- FAIL_TO_PASS: test_runshell_use_environ (backends.base.test_client.SimpleDatabaseClientTests); test_settings_to_cmd_args_env (backends.base.test_client.SimpleDatabaseClientTests); test_accent (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_basic (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_column (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_crash_password_does_not_leak (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_nopass (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_parameters (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_passfile (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_service (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase); test_ssl_certificate (dbshell.test_postgresql.PostgreSqlDbshellCommandTestCase)
- gold test files: tests/backends/base/test_client.py, tests/dbshell/test_postgresql.py
- agent modified: django/db/backends/base/client.py
- gold asserts (0):

## django__django-14349
- FAIL_TO_PASS: test_validators (validators.tests.TestValidators)
- gold test files: tests/validators/tests.py
- agent modified: django/core/validators.py
- gold asserts (0):

## django__django-14376
- FAIL_TO_PASS: test_options_non_deprecated_keys_preferred (dbshell.test_mysql.MySqlDbshellCommandTestCase); test_options_override_settings_proper_values (dbshell.test_mysql.MySqlDbshellCommandTestCase); test_parameters (dbshell.test_mysql.MySqlDbshellCommandTestCase)
- gold test files: tests/dbshell/test_mysql.py
- agent modified: django/db/backends/mysql/base.py
- gold asserts (1):
  - `self.assertEqual(`

## django__django-15098
- FAIL_TO_PASS: test_get_language_from_path_real (i18n.tests.MiscTests); test_get_supported_language_variant_null (i18n.tests.MiscTests)
- gold test files: tests/i18n/tests.py
- agent modified: django/utils/translation/trans_real.py
- gold asserts (1):
  - `self.assertEqual(g(path), language)`

## django__django-15127
- FAIL_TO_PASS: test_override_settings_level_tags (messages_tests.tests.TestLevelTags)
- gold test files: tests/messages_tests/base.py, tests/messages_tests/tests.py
- agent modified: django/contrib/messages/storage/base.py
- gold asserts (1):
  - `self.assertEqual(base.LEVEL_TAGS, self.message_tags)`

## django__django-15252
- FAIL_TO_PASS: test_migrate_test_setting_false_ensure_schema (backends.base.test_creation.TestDbCreationTests); The django_migrations table is not created if there are no migrations
- gold test files: tests/backends/base/test_creation.py, tests/migrations/test_executor.py
- agent modified: django/db/migrations/recorder.py
- gold asserts (1):
  - `self.assertEqual(mocked_args[1], {'app_unmigrated'})`

## django__django-15629
- FAIL_TO_PASS: AlterField operation of db_collation on primary keys changes any FKs; Creation of models with a FK to a PK with db_collation.
- gold test files: tests/migrations/test_base.py, tests/migrations/test_operations.py
- agent modified: django/db/backends/base/schema.py, django/db/models/fields/related.py
- gold asserts (1):
  - `self.assertEqual(self._get_column_collation(table, column, using), collation)`

## django__django-15732
- FAIL_TO_PASS: test_remove_unique_together_on_unique_field (migrations.test_operations.OperationTests)
- gold test files: tests/migrations/test_operations.py
- agent modified: django/db/backends/base/schema.py
- gold asserts (0):

## django__django-15916
- FAIL_TO_PASS: test_custom_callback_from_base_form_meta (model_forms.tests.FormFieldCallbackTests); test_custom_callback_in_meta (model_forms.tests.FormFieldCallbackTests)
- gold test files: tests/model_forms/tests.py
- agent modified: django/forms/models.py
- gold asserts (3):
  - `self.assertEqual(type(field.widget), forms.Textarea)`
  - `self.assertEqual(type(field.widget), forms.Textarea)`
  - `self.assertEqual(`

## django__django-16256
- FAIL_TO_PASS: test_acreate (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_acreate_reverse (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_aget_or_create (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_aget_or_create_reverse (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_aupdate_or_create (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_aupdate_or_create_reverse (async.test_async_related_managers.AsyncRelatedManagersOperationTest); test_generic_async_acreate (generic_relations.tests.GenericRelationsTests); test_generic_async_aget_or_create (generic_relations.tests.GenericRelationsTests); test_generic_async_aupdate_or_create (generic_relations.tests.GenericRelationsTests)
- gold test files: tests/async/models.py, tests/async/test_async_related_managers.py, tests/generic_relations/tests.py
- agent modified: django/db/models/fields/related_descriptors.py
- gold asserts (23):
  - `self.assertEqual(new_simple.field, 2)`
  - `self.assertEqual(new_relatedmodel.simple, self.s1)`
  - `self.assertEqual(await self.mtm1.simples.acount(), 1)`
  - `self.assertEqual(new_simple.field, 2)`
  - `self.assertEqual(await self.mtm1.simples.acount(), 1)`
  - `self.assertEqual(new_simple.field, 2)`
  - `self.assertEqual(await self.s1.relatedmodel_set.acount(), 1)`
  - `self.assertEqual(new_relatedmodel.simple, self.s1)`
  - `self.assertEqual(await self.mtm1.simples.acount(), 1)`
  - `self.assertEqual(new_simple.field, 2)`
  - `self.assertEqual(await self.mtm1.simples.acount(), 1)`
  - `self.assertEqual(new_simple.field, 3)`

## django__django-16454
- FAIL_TO_PASS: test_subparser_error_formatting (user_commands.tests.CommandRunTests.test_subparser_error_formatting)
- gold test files: tests/user_commands/management/commands/subparser_vanilla.py, tests/user_commands/tests.py
- agent modified: django/core/management/base.py
- gold asserts (4):
  - `self.assertEqual(len(err_lines), 2)`
  - `self.assertEqual(`
  - `self.assertEqual(len(err_lines), 2)`
  - `self.assertEqual(`

## django__django-16485
- FAIL_TO_PASS: test_zero_values (template_tests.filter_tests.test_floatformat.FunctionTests.test_zero_values)
- gold test files: tests/template_tests/filter_tests/test_floatformat.py
- agent modified: django/template/defaultfilters.py
- gold asserts (2):
  - `self.assertEqual(floatformat("0.00", 0), "0")`
  - `self.assertEqual(floatformat(Decimal("0.00"), 0), "0")`

## django__django-16493
- FAIL_TO_PASS: A callable that returns default_storage is not omitted when
- gold test files: tests/file_storage/models.py, tests/file_storage/tests.py
- agent modified: django/db/models/fields/files.py
- gold asserts (0):

## django__django-16502
- FAIL_TO_PASS: test_no_body_returned_for_head_requests (servers.test_basehttp.WSGIRequestHandlerTestCase.test_no_body_returned_for_head_requests)
- gold test files: tests/servers/test_basehttp.py
- agent modified: django/core/servers/basehttp.py
- gold asserts (5):
  - `self.assertEqual(body, hello_world_body)`
  - `self.assertIn(f"Content-Length: {content_length}\r\n".encode(), lines)`
  - `self.assertNotIn(b"Connection: close\r\n", lines)`
  - `self.assertEqual(body, b"\r\n")`
  - `self.assertNotIn(b"Connection: close\r\n", lines)`

## django__django-16527
- FAIL_TO_PASS: test_submit_row_save_as_new_add_permission_required (admin_views.test_templatetags.AdminTemplateTagsTest.test_submit_row_save_as_new_add_permission_required)
- gold test files: tests/admin_views/test_templatetags.py
- agent modified: django/contrib/admin/templatetags/admin_modify.py
- gold asserts (0):

## django__django-16560
- FAIL_TO_PASS: test_custom_violation_code_message (constraints.tests.BaseConstraintTests.test_custom_violation_code_message); test_deconstruction (constraints.tests.BaseConstraintTests.test_deconstruction); test_eq (constraints.tests.CheckConstraintTests.test_eq); test_repr_with_violation_error_code (constraints.tests.CheckConstraintTests.test_repr_with_violation_error_code); test_validate_custom_error (constraints.tests.CheckConstraintTests.test_validate_custom_error); test_eq (constraints.tests.UniqueConstraintTests.test_eq); test_repr_with_violation_error_code (constraints.tests.UniqueConstraintTests.test_repr_with_violation_error_code); test_validate_conditon_custom_error (constraints.tests.UniqueConstraintTests.test_validate_conditon_custom_error)
- gold test files: tests/constraints/tests.py, tests/postgres_tests/test_constraints.py
- agent modified: django/contrib/postgres/constraints.py, django/db/models/constraints.py
- gold asserts (17):
  - `self.assertEqual(c.violation_error_code, "custom_code")`
  - `self.assertEqual(`
  - `self.assertEqual(`
  - `with self.assertRaisesMessage(ValidationError, msg) as cm:`
  - `self.assertEqual(cm.exception.code, "fake_discount")`
  - `self.assertEqual(`
  - `self.assertEqual(`
  - `with self.assertRaisesMessage(ValidationError, msg) as cm:`
  - `self.assertEqual(cm.exception.code, "unique_together")`
  - `with self.assertRaisesMessage(ValidationError, msg) as cm:`
  - `self.assertEqual(cm.exception.code, "custom_code")`
  - `self.assertEqual(`

## django__django-16569
- FAIL_TO_PASS: test_disable_delete_extra_formset_forms (forms_tests.tests.test_formsets.FormsFormsetTestCase.test_disable_delete_extra_formset_forms); test_disable_delete_extra_formset_forms (forms_tests.tests.test_formsets.Jinja2FormsFormsetTestCase.test_disable_delete_extra_formset_forms)
- gold test files: tests/forms_tests/tests/test_formsets.py
- agent modified: django/forms/formsets.py
- gold asserts (1):
  - `self.assertNotIn("DELETE", formset.empty_form.fields)`

## django__django-16595
- FAIL_TO_PASS: test_alter_alter_field (migrations.test_optimizer.OptimizerTests.test_alter_alter_field)
- gold test files: tests/migrations/test_optimizer.py
- agent modified: django/db/migrations/operations/fields.py
- gold asserts (0):

## django__django-16612
- FAIL_TO_PASS: test_missing_slash_append_slash_true_query_string (admin_views.tests.AdminSiteFinalCatchAllPatternTests.test_missing_slash_append_slash_true_query_string); test_missing_slash_append_slash_true_script_name_query_string (admin_views.tests.AdminSiteFinalCatchAllPatternTests.test_missing_slash_append_slash_true_script_name_query_string)
- gold test files: tests/admin_views/tests.py
- agent modified: django/contrib/admin/sites.py
- gold asserts (0):

## django__django-16631
- FAIL_TO_PASS: test_get_user_fallback_secret (auth_tests.test_basic.TestGetUser.test_get_user_fallback_secret)
- gold test files: tests/auth_tests/test_basic.py
- agent modified: django/contrib/auth/__init__.py, django/contrib/auth/base_user.py, django/utils/crypto.py
- gold asserts (2):
  - `self.assertEqual(user.username, created_user.username)`
  - `self.assertEqual(user.username, created_user.username)`

## django__django-16642
- FAIL_TO_PASS: If compressed responses are served with the uncompressed Content-Type
- gold test files: tests/responses/test_fileresponse.py
- agent modified: django/http/response.py
- gold asserts (0):

## django__django-16661
- FAIL_TO_PASS: test_lookup_allowed_foreign_primary (modeladmin.tests.ModelAdminTests.test_lookup_allowed_foreign_primary)
- gold test files: tests/modeladmin/tests.py
- agent modified: django/contrib/admin/options.py
- gold asserts (0):

## django__django-16662
- FAIL_TO_PASS: #24155 - Tests ordering of imports.
- gold test files: tests/migrations/test_writer.py
- agent modified: django/db/migrations/writer.py
- gold asserts (0):

## django__django-16667
- FAIL_TO_PASS: test_form_field (forms_tests.field_tests.test_datefield.DateFieldTest.test_form_field); test_value_from_datadict (forms_tests.widget_tests.test_selectdatewidget.SelectDateWidgetTest.test_value_from_datadict)
- gold test files: tests/forms_tests/field_tests/test_datefield.py, tests/forms_tests/widget_tests/test_selectdatewidget.py
- agent modified: django/forms/widgets.py
- gold asserts (2):
  - `self.assertEqual(e.errors, {"mydate": ["Enter a valid date."]})`
  - `with self.assertRaisesMessage(ValidationError, "'Enter a valid date.'"):`

## django__django-16801
- FAIL_TO_PASS: test_post_init_not_connected (model_fields.test_imagefield.ImageFieldNoDimensionsTests.test_post_init_not_connected)
- gold test files: tests/model_fields/test_imagefield.py
- agent modified: django/db/models/fields/files.py
- gold asserts (1):
  - `self.assertNotIn(`

## django__django-16819
- FAIL_TO_PASS: test_add_remove_index (migrations.test_optimizer.OptimizerTests.test_add_remove_index)
- gold test files: tests/migrations/test_optimizer.py
- agent modified: django/db/migrations/operations/models.py
- gold asserts (0):

## django__django-16877
- FAIL_TO_PASS: test_autoescape_off (template_tests.filter_tests.test_escapeseq.EscapeseqTests.test_autoescape_off); test_basic (template_tests.filter_tests.test_escapeseq.EscapeseqTests.test_basic); test_chain_join (template_tests.filter_tests.test_escapeseq.EscapeseqTests.test_chain_join); test_chain_join_autoescape_off (template_tests.filter_tests.test_escapeseq.EscapeseqTests.test_chain_join_autoescape_off)
- gold test files: tests/template_tests/filter_tests/test_escapeseq.py
- agent modified: django/template/defaultfilters.py, docs/ref/templates/builtins.txt
- gold asserts (4):
  - `self.assertEqual(output, "x&amp;y, &lt;p&gt; -- x&y, <p>")`
  - `self.assertEqual(output, "x&amp;y, &lt;p&gt; -- x&y, <p>")`
  - `self.assertEqual(output, "x&amp;y<br/>&lt;p&gt;")`
  - `self.assertEqual(output, "x&amp;y<br/>&lt;p&gt;")`

## django__django-16899
- FAIL_TO_PASS: test_nonexistent_field (admin_checks.tests.SystemChecksTestCase.test_nonexistent_field); test_nonexistent_field_on_inline (admin_checks.tests.SystemChecksTestCase.test_nonexistent_field_on_inline)
- gold test files: tests/admin_checks/tests.py
- agent modified: django/contrib/admin/checks.py
- gold asserts (0):

## django__django-16901
- FAIL_TO_PASS: test_filter_multiple (xor_lookups.tests.XorLookupsTests.test_filter_multiple)
- gold test files: tests/xor_lookups/tests.py
- agent modified: django/apps/registry.py, django/db/models/sql/where.py
- gold asserts (0):

## django__django-16938
- FAIL_TO_PASS: The ability to create new objects by modifying serialized content.; Deserialized content can be saved with force_insert as a parameter.; Mapping such as fields should be deterministically ordered. (#24558); Year values before 1000AD are properly formatted; Basic serialization works.; test_serialize_no_only_pk_with_natural_keys (serializers.test_json.JsonSerializerTestCase.test_serialize_no_only_pk_with_natural_keys); test_serialize_only_pk (serializers.test_json.JsonSerializerTestCase.test_serialize_only_pk); test_serialize_prefetch_related_m2m (serializers.test_json.JsonSerializerTestCase.test_serialize_prefetch_related_m2m); test_serialize_progressbar (serializers.test_json.JsonSerializerTestCase.test_serialize_progressbar); Serialized content can be deserialized.; test_serialize_no_only_pk_with_natural_keys (serializers.test_yaml.YamlSerializerTestCase.test_serialize_no_only_pk_with_natural_keys); test_serialize_only_pk (serializers.test_yaml.YamlSerializerTestCase.test_serialize_only_pk); test_serialize_prefetch_related_m2m (serializers.test_yaml.YamlSerializerTestCase.test_serialize_prefetch_related_m2m); test_serialize_progressbar (serializers.test_yaml.YamlSerializerTestCase.test_serialize_progressbar); test_serialize_no_only_pk_with_natural_keys (serializers.test_jsonl.JsonlSerializerTestCase.test_serialize_no_only_pk_with_natural_keys); test_serialize_only_pk (serializers.test_jsonl.JsonlSerializerTestCase.test_serialize_only_pk); test_serialize_prefetch_related_m2m (serializers.test_jsonl.JsonlSerializerTestCase.test_serialize_prefetch_related_m2m); test_serialize_progressbar (serializers.test_jsonl.JsonlSerializerTestCase.test_serialize_progressbar); Serializing control characters with XML should fail as those characters; test_serialize_no_only_pk_with_natural_keys (serializers.test_xml.XmlSerializerTestCase.test_serialize_no_only_pk_with_natural_keys); test_serialize_only_pk (serializers.test_xml.XmlSerializerTestCase.test_serialize_only_pk); test_serialize_prefetch_related_m2m (serializers.test_xml.XmlSerializerTestCase.test_serialize_prefetch_related_m2m); test_serialize_progressbar (serializers.test_xml.XmlSerializerTestCase.test_serialize_progressbar)
- gold test files: tests/serializers/models/base.py, tests/serializers/test_json.py, tests/serializers/test_jsonl.py, tests/serializers/test_xml.py, tests/serializers/test_yaml.py, tests/serializers/tests.py
- agent modified: django/core/serializers/python.py, django/core/serializers/xml_serializer.py
- gold asserts (2):
  - `self.assertNotIn(connection.ops.quote_name("category_id"), topics_data_sql)`
  - `self.assertNotIn(connection.ops.quote_name("category_id"), topics_data_sql)`

## django__django-16950
- FAIL_TO_PASS: If form data is provided, a parent's auto-generated alternate key is
- gold test files: tests/model_formsets/test_uuid.py
- agent modified: django/forms/models.py
- gold asserts (4):
  - `self.assertIsNone(formset.instance.uuid)`
  - `self.assertIsNone(formset.forms[0].instance.parent_id)`
  - `self.assertIsNotNone(formset.instance.uuid)`
  - `self.assertEqual(formset.forms[0].instance.parent_id, formset.instance.uuid)`

## django__django-17029
- FAIL_TO_PASS: test_clear_cache (apps.tests.AppsTests.test_clear_cache)
- gold test files: tests/apps/tests.py
- agent modified: django/apps/registry.py
- gold asserts (3):
  - `self.assertIsNone(apps.get_swappable_settings_name("admin.LogEntry"))`
  - `self.assertEqual(apps.get_swappable_settings_name.cache_info().currsize, 0)`
  - `self.assertEqual(apps.get_models.cache_info().currsize, 0)`

## django__django-17084
- FAIL_TO_PASS: test_referenced_window_requires_wrapping (aggregation.tests.AggregateAnnotationPruningTests.test_referenced_window_requires_wrapping)
- gold test files: tests/aggregation/tests.py
- agent modified: django/db/models/sql/query.py
- gold asserts (2):
  - `self.assertEqual(sql.count("select"), 2, "Subquery wrapping required")`
  - `self.assertEqual(`

## django__django-17087
- FAIL_TO_PASS: test_serialize_nested_class_method (migrations.test_writer.WriterTests.test_serialize_nested_class_method)
- gold test files: tests/migrations/test_writer.py
- agent modified: django/db/migrations/serializer.py
- gold asserts (0):

## django__django-7530
- FAIL_TO_PASS: test_squashmigrations_initial_attribute (migrations.test_commands.SquashMigrationsTests)
- gold test files: tests/migrations/test_commands.py
- agent modified: django/core/management/commands/makemigrations.py
- gold asserts (1):
  - `self.assertIn(connection_alias, ['default', 'other'])`

## mwaskom__seaborn-3187
- FAIL_TO_PASS: tests/_core/test_plot.py::TestLegend::test_legend_has_no_offset; tests/test_relational.py::TestRelationalPlotter::test_legend_has_no_offset
- gold test files: tests/_core/test_plot.py, tests/test_relational.py
- agent modified: seaborn/_core/scales.py, seaborn/utils.py
- gold asserts (0):

## pallets__flask-5014
- FAIL_TO_PASS: tests/test_blueprints.py::test_empty_name_not_allowed
- gold test files: tests/test_blueprints.py
- agent modified: src/flask/blueprints.py
- gold asserts (0):

## psf__requests-1921
- FAIL_TO_PASS: test_requests.py::RequestsTestCase::test_DIGESTAUTH_WRONG_HTTP_401_GET; test_requests.py::RequestsTestCase::test_POSTBIN_GET_POST_FILES; test_requests.py::RequestsTestCase::test_basicauth_with_netrc; test_requests.py::RequestsTestCase::test_cookie_persists_via_api; test_requests.py::RequestsTestCase::test_headers_on_session_with_None_are_not_sent; test_requests.py::RequestsTestCase::test_uppercase_scheme_redirect
- gold test files: test_requests.py
- agent modified: requests/sessions.py
- gold asserts (0):

## psf__requests-2317
- FAIL_TO_PASS: test_requests.py::RequestsTestCase::test_HTTP_302_ALLOW_REDIRECT_GET; test_requests.py::RequestsTestCase::test_POSTBIN_GET_POST_FILES; test_requests.py::RequestsTestCase::test_POSTBIN_GET_POST_FILES_WITH_DATA; test_requests.py::RequestsTestCase::test_basicauth_with_netrc; test_requests.py::RequestsTestCase::test_json_param_post_content_type_works; test_requests.py::RequestsTestCase::test_manual_redirect_with_partial_body_read; test_requests.py::RequestsTestCase::test_requests_history_is_saved; test_requests.py::TestTimeout::test_encoded_methods
- gold test files: test_requests.py
- agent modified: requests/models.py, requests/sessions.py
- gold asserts (0):

## psf__requests-2931
- FAIL_TO_PASS: test_requests.py::TestRequests::test_binary_put
- gold test files: test_requests.py
- agent modified: requests/models.py
- gold asserts (0):

## psf__requests-5414
- FAIL_TO_PASS: tests/test_requests.py::TestRequests::test_invalid_url[InvalidURL-http://.example.com]
- gold test files: tests/test_requests.py
- agent modified: requests/models.py
- gold asserts (0):

## psf__requests-6028
- FAIL_TO_PASS: tests/test_utils.py::test_prepend_scheme_if_needed[http://user:pass@example.com/path?query-http://user:pass@example.com/path?query]; tests/test_utils.py::test_prepend_scheme_if_needed[http://user@example.com/path?query-http://user@example.com/path?query]
- gold test files: tests/test_utils.py
- agent modified: requests/utils.py
- gold asserts (0):

## pydata__xarray-2905
- FAIL_TO_PASS: xarray/tests/test_variable.py::TestAsCompatibleData::test_unsupported_type
- gold test files: xarray/tests/test_variable.py
- agent modified: xarray/core/variable.py
- gold asserts (0):

## pydata__xarray-3095
- FAIL_TO_PASS: xarray/tests/test_variable.py::TestIndexVariable::test_copy[str-True]
- gold test files: xarray/tests/test_variable.py
- agent modified: xarray/core/indexing.py, xarray/core/variable.py
- gold asserts (0):

## pydata__xarray-3151
- FAIL_TO_PASS: xarray/tests/test_combine.py::TestCombineAuto::test_combine_leaving_bystander_dimensions
- gold test files: xarray/tests/test_combine.py
- agent modified: xarray/core/combine.py
- gold asserts (0):

## pydata__xarray-3305
- FAIL_TO_PASS: xarray/tests/test_dataarray.py::TestDataArray::test_quantile
- gold test files: xarray/tests/test_dataarray.py
- agent modified: xarray/core/dataset.py, xarray/core/variable.py
- gold asserts (0):

## pydata__xarray-3677
- FAIL_TO_PASS: xarray/tests/test_merge.py::TestMergeMethod::test_merge_dataarray
- gold test files: xarray/tests/test_merge.py
- agent modified: xarray/core/merge.py
- gold asserts (0):

## pydata__xarray-3993
- FAIL_TO_PASS: xarray/tests/test_dataset.py::test_integrate[True]; xarray/tests/test_dataset.py::test_integrate[False]
- gold test files: xarray/tests/test_dataset.py, xarray/tests/test_units.py
- agent modified: doc/whats-new.rst, xarray/core/dataarray.py
- gold asserts (0):

## pydata__xarray-4075
- FAIL_TO_PASS: xarray/tests/test_weighted.py::test_weighted_sum_of_weights_bool; xarray/tests/test_weighted.py::test_weighted_mean_bool
- gold test files: xarray/tests/test_weighted.py
- agent modified: xarray/core/weighted.py
- gold asserts (0):

## pydata__xarray-4094
- FAIL_TO_PASS: xarray/tests/test_dataset.py::TestDataset::test_to_stacked_array_to_unstacked_dataset
- gold test files: xarray/tests/test_dataset.py
- agent modified: xarray/core/dataarray.py
- gold asserts (0):

## pydata__xarray-4356
- FAIL_TO_PASS: xarray/tests/test_duck_array_ops.py::test_min_count_nd[sum-False-float]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[sum-False-int]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[sum-False-float32]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[sum-False-bool_]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[prod-False-float]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[prod-False-int]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[prod-False-float32]; xarray/tests/test_duck_array_ops.py::test_min_count_nd[prod-False-bool_]
- gold test files: xarray/tests/test_duck_array_ops.py
- agent modified: xarray/core/nanops.py
- gold asserts (0):

## pydata__xarray-4687
- FAIL_TO_PASS: xarray/tests/test_computation.py::test_where_attrs
- gold test files: xarray/tests/test_computation.py, xarray/tests/test_units.py
- agent modified: xarray/core/computation.py
- gold asserts (0):

## pydata__xarray-4695
- FAIL_TO_PASS: xarray/tests/test_dataarray.py::TestDataArray::test_loc_dim_name_collision_with_sel_params
- gold test files: xarray/tests/test_dataarray.py
- agent modified: xarray/core/dataarray.py
- gold asserts (0):

## pydata__xarray-4966
- FAIL_TO_PASS: xarray/tests/test_coding.py::test_decode_signed_from_unsigned[1]; xarray/tests/test_coding.py::test_decode_signed_from_unsigned[2]; xarray/tests/test_coding.py::test_decode_signed_from_unsigned[4]; xarray/tests/test_coding.py::test_decode_signed_from_unsigned[8]
- gold test files: xarray/tests/test_coding.py
- agent modified: xarray/coding/variables.py
- gold asserts (0):

## pydata__xarray-6461
- FAIL_TO_PASS: xarray/tests/test_computation.py::test_where_attrs
- gold test files: xarray/tests/test_computation.py
- agent modified: xarray/core/computation.py
- gold asserts (0):

## pydata__xarray-6599
- FAIL_TO_PASS: xarray/tests/test_computation.py::test_polyval[timedelta-False]
- gold test files: xarray/tests/test_computation.py
- agent modified: xarray/core/computation.py
- gold asserts (0):

## pydata__xarray-6721
- FAIL_TO_PASS: xarray/tests/test_dataset.py::TestDataset::test_chunks_does_not_load_data
- gold test files: xarray/tests/test_dataset.py
- agent modified: xarray/core/common.py, xarray/core/variable.py
- gold asserts (0):

## pydata__xarray-6744
- FAIL_TO_PASS: xarray/tests/test_rolling.py::TestDataArrayRolling::test_rolling_iter[numpy-3-True-1]; xarray/tests/test_rolling.py::TestDataArrayRolling::test_rolling_iter[numpy-3-True-2]; xarray/tests/test_rolling.py::TestDataArrayRolling::test_rolling_iter[numpy-7-True-1]
- gold test files: xarray/tests/test_rolling.py
- agent modified: xarray/core/rolling.py
- gold asserts (0):

## pydata__xarray-6938
- FAIL_TO_PASS: xarray/tests/test_variable.py::TestIndexVariable::test_to_index_variable_copy
- gold test files: xarray/tests/test_variable.py
- agent modified: xarray/core/dataset.py
- gold asserts (0):

## pydata__xarray-6992
- FAIL_TO_PASS: xarray/tests/test_dataarray.py::TestDataArray::test_reset_index; xarray/tests/test_dataset.py::TestDataset::test_reset_index; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_dims; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[foo-False-dropped0-converted0-renamed0]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[foo-True-dropped1-converted1-renamed1]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[x-False-dropped2-converted2-renamed2]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[x-True-dropped3-converted3-renamed3]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[arg4-False-dropped4-converted4-renamed4]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[arg5-True-dropped5-converted5-renamed5]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[arg6-False-dropped6-converted6-renamed6]; xarray/tests/test_dataset.py::TestDataset::test_reset_index_drop_convert[arg7-True-dropped7-converted7-renamed7]; xarray/tests/test_groupby.py::test_groupby_drops_nans
- gold test files: xarray/tests/test_dataarray.py, xarray/tests/test_dataset.py, xarray/tests/test_groupby.py
- agent modified: xarray/core/dataset.py
- gold asserts (0):

## pydata__xarray-7229
- FAIL_TO_PASS: xarray/tests/test_computation.py::test_where_attrs
- gold test files: xarray/tests/test_computation.py
- agent modified: xarray/core/computation.py
- gold asserts (0):

## pydata__xarray-7233
- FAIL_TO_PASS: xarray/tests/test_coarsen.py::TestCoarsenConstruct::test_coarsen_construct_keeps_all_coords
- gold test files: xarray/tests/test_coarsen.py
- agent modified: xarray/core/rolling.py
- gold asserts (0):

## pydata__xarray-7393
- FAIL_TO_PASS: xarray/tests/test_indexes.py::test_restore_dtype_on_multiindexes[int32]; xarray/tests/test_indexes.py::test_restore_dtype_on_multiindexes[float32]
- gold test files: xarray/tests/test_indexes.py
- agent modified: xarray/core/indexing.py
- gold asserts (0):

## pylint-dev__pylint-4551
- FAIL_TO_PASS: tests/unittest_pyreverse_writer.py::test_dot_files[packages_No_Name.dot]; tests/unittest_pyreverse_writer.py::test_dot_files[classes_No_Name.dot]; tests/unittest_pyreverse_writer.py::test_get_visibility[names0-special]; tests/unittest_pyreverse_writer.py::test_get_visibility[names1-private]; tests/unittest_pyreverse_writer.py::test_get_visibility[names2-public]; tests/unittest_pyreverse_writer.py::test_get_visibility[names3-protected]; tests/unittest_pyreverse_writer.py::test_get_annotation_annassign[a:; tests/unittest_pyreverse_writer.py::test_get_annotation_assignattr[def; tests/unittest_pyreverse_writer.py::test_infer_node_1; tests/unittest_pyreverse_writer.py::test_infer_node_2
- gold test files: tests/unittest_pyreverse_writer.py
- agent modified: pylint/pyreverse/diagrams.py, pylint/pyreverse/inspector.py, pylint/pyreverse/utils.py
- gold asserts (0):

## pylint-dev__pylint-4604
- FAIL_TO_PASS: tests/checkers/unittest_variables.py::TestVariablesChecker::test_bitbucket_issue_78; tests/checkers/unittest_variables.py::TestVariablesChecker::test_no_name_in_module_skipped; tests/checkers/unittest_variables.py::TestVariablesChecker::test_all_elements_without_parent; tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_ignored; tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_custom_modules; tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_modname_not_ignored; tests/checkers/unittest_variables.py::TestVariablesChecker::test_redefined_builtin_in_function; tests/checkers/unittest_variables.py::TestVariablesChecker::test_unassigned_global; tests/checkers/unittest_variables.py::TestVariablesChecker::test_listcomp_in_decorator; tests/checkers/unittest_variables.py::TestVariablesChecker::test_listcomp_in_ancestors; tests/checkers/unittest_variables.py::TestVariablesChecker::test_return_type_annotation; tests/checkers/unittest_variables.py::TestVariablesChecker::test_attribute_in_type_comment; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_custom_callback_string; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_redefined_builtin_modname_not_ignored; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_redefined_builtin_in_function; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_import_as_underscore; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_lambda_in_classdef; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_nested_lambda; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_ignored_argument_names_no_message; tests/checkers/unittest_variables.py::TestVariablesCheckerWithTearDown::test_ignored_argument_names_starred_args; tests/checkers/unittest_variables.py::TestMissingSubmodule::test_package_all
- gold test files: tests/checkers/unittest_variables.py
- agent modified: pylint/checkers/variables.py
- gold asserts (0):

## pylint-dev__pylint-4661
- FAIL_TO_PASS: tests/lint/unittest_lint.py::test_pylint_home
- gold test files: tests/lint/unittest_lint.py
- agent modified: ChangeLog, doc/faq.rst, doc/whatsnew/2.10.rst, pylint/config/__init__.py
- gold asserts (0):

## pylint-dev__pylint-6903
- FAIL_TO_PASS: tests/test_pylint_runners.py::test_pylint_run_jobs_equal_zero_dont_crash_with_cpu_fraction
- gold test files: tests/test_pylint_runners.py
- agent modified: pylint/lint/run.py
- gold asserts (0):

## pylint-dev__pylint-7080
- FAIL_TO_PASS: tests/test_self.py::TestRunTC::test_ignore_path_recursive_current_dir
- gold test files: tests/test_self.py
- agent modified: pylint/lint/pylinter.py
- gold asserts (0):

## pylint-dev__pylint-7277
- FAIL_TO_PASS: tests/test_self.py::TestRunTC::test_modify_sys_path
- gold test files: tests/test_self.py
- agent modified: pylint/__init__.py
- gold asserts (0):

## pylint-dev__pylint-8898
- FAIL_TO_PASS: tests/config/test_config.py::test_csv_regex_error
- gold test files: tests/config/test_config.py
- agent modified: pylint/config/argument.py, pylint/utils/__init__.py, pylint/utils/utils.py
- gold asserts (0):

## pytest-dev__pytest-10051
- FAIL_TO_PASS: testing/logging/test_fixture.py::test_clear_for_call_stage
- gold test files: testing/logging/test_fixture.py
- agent modified: src/_pytest/logging.py
- gold asserts (0):

## pytest-dev__pytest-10081
- FAIL_TO_PASS: testing/test_unittest.py::test_pdb_teardown_skipped_for_classes[@unittest.skip]
- gold test files: testing/test_unittest.py
- agent modified: src/_pytest/unittest.py
- gold asserts (0):

## pytest-dev__pytest-10356
- FAIL_TO_PASS: testing/test_mark.py::test_mark_mro
- gold test files: testing/test_mark.py
- agent modified: src/_pytest/mark/structures.py
- gold asserts (0):

## pytest-dev__pytest-5262
- FAIL_TO_PASS: testing/test_capture.py::TestFDCapture::test_capfd_sys_stdout_mode
- gold test files: testing/test_capture.py
- agent modified: src/_pytest/capture.py
- gold asserts (0):

## pytest-dev__pytest-5631
- FAIL_TO_PASS: testing/python/integration.py::TestMockDecoration::test_mock_sentinel_check_against_numpy_like
- gold test files: testing/python/integration.py
- agent modified: src/_pytest/compat.py
- gold asserts (0):

## pytest-dev__pytest-5787
- FAIL_TO_PASS: testing/test_reports.py::TestReportSerialization::test_chained_exceptions[TestReport]; testing/test_reports.py::TestReportSerialization::test_chained_exceptions[CollectReport]
- gold test files: testing/code/test_code.py, testing/code/test_excinfo.py, testing/conftest.py, testing/test_reports.py
- agent modified: src/_pytest/reports.py
- gold asserts (0):

## pytest-dev__pytest-5809
- FAIL_TO_PASS: testing/test_pastebin.py::TestPaste::test_create_new_paste
- gold test files: testing/test_pastebin.py
- agent modified: src/_pytest/pastebin.py
- gold asserts (0):

## pytest-dev__pytest-5840
- FAIL_TO_PASS: testing/test_conftest.py::test_setinitial_conftest_subdirs[test]; testing/test_conftest.py::test_setinitial_conftest_subdirs[tests]
- gold test files: testing/test_conftest.py
- agent modified: src/_pytest/config/__init__.py
- gold asserts (0):

## pytest-dev__pytest-6197
- FAIL_TO_PASS: testing/test_collection.py::test_does_not_eagerly_collect_packages; testing/test_collection.py::test_does_not_put_src_on_path
- gold test files: testing/test_collection.py, testing/test_skipping.py
- agent modified: src/_pytest/python.py
- gold asserts (0):

## pytest-dev__pytest-6202
- FAIL_TO_PASS: testing/test_collection.py::Test_genitems::test_example_items1
- gold test files: testing/test_collection.py
- agent modified: src/_pytest/python.py
- gold asserts (0):

## pytest-dev__pytest-7205
- FAIL_TO_PASS: testing/test_setuponly.py::test_show_fixtures_with_parameters[--setup-only]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids[--setup-only]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids_function[--setup-only]; testing/test_setuponly.py::test_show_fixtures_with_parameters[--setup-plan]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids[--setup-plan]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids_function[--setup-plan]; testing/test_setuponly.py::test_show_fixtures_with_parameters[--setup-show]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids[--setup-show]; testing/test_setuponly.py::test_show_fixtures_with_parameter_ids_function[--setup-show]; testing/test_setuponly.py::test_show_fixture_action_with_bytes
- gold test files: testing/test_setuponly.py
- agent modified: src/_pytest/setuponly.py
- gold asserts (0):

## pytest-dev__pytest-7236
- FAIL_TO_PASS: testing/test_unittest.py::test_pdb_teardown_skipped[@unittest.skip]
- gold test files: testing/test_unittest.py
- agent modified: src/_pytest/unittest.py
- gold asserts (0):

## pytest-dev__pytest-7324
- FAIL_TO_PASS: testing/test_mark_expression.py::test_valid_idents[True]; testing/test_mark_expression.py::test_valid_idents[False]; testing/test_mark_expression.py::test_valid_idents[None]
- gold test files: testing/test_mark_expression.py
- agent modified: src/_pytest/mark/expression.py
- gold asserts (0):

## pytest-dev__pytest-7432
- FAIL_TO_PASS: testing/test_skipping.py::TestXFail::test_xfail_run_with_skip_mark[test_input1-expected1]
- gold test files: testing/test_skipping.py
- agent modified: src/_pytest/skipping.py
- gold asserts (0):

## pytest-dev__pytest-7490
- FAIL_TO_PASS: testing/test_skipping.py::TestXFail::test_dynamic_xfail_set_during_runtest_failed; testing/test_skipping.py::TestXFail::test_dynamic_xfail_set_during_runtest_passed_strict
- gold test files: testing/test_skipping.py
- agent modified: src/_pytest/skipping.py
- gold asserts (0):

## pytest-dev__pytest-7521
- FAIL_TO_PASS: testing/test_capture.py::TestCaptureFixture::test_cafd_preserves_newlines[\r\n]; testing/test_capture.py::TestCaptureFixture::test_cafd_preserves_newlines[\r]
- gold test files: testing/test_capture.py
- agent modified: src/_pytest/capture.py
- gold asserts (0):

## pytest-dev__pytest-7571
- FAIL_TO_PASS: testing/logging/test_fixture.py::test_change_level_undos_handler_level
- gold test files: testing/logging/test_fixture.py
- agent modified: src/_pytest/logging.py
- gold asserts (0):

## pytest-dev__pytest-7982
- FAIL_TO_PASS: testing/test_collection.py::test_collect_symlink_dir
- gold test files: testing/test_collection.py
- agent modified: src/_pytest/pathlib.py
- gold asserts (0):

## pytest-dev__pytest-8399
- FAIL_TO_PASS: testing/test_unittest.py::test_fixtures_setup_setUpClass_issue8394
- gold test files: testing/test_nose.py, testing/test_unittest.py
- agent modified: src/_pytest/unittest.py
- gold asserts (0):

## scikit-learn__scikit-learn-10297
- FAIL_TO_PASS: sklearn/linear_model/tests/test_ridge.py::test_ridge_classifier_cv_store_cv_values
- gold test files: sklearn/linear_model/tests/test_ridge.py
- agent modified: sklearn/linear_model/ridge.py
- gold asserts (0):

## scikit-learn__scikit-learn-10844
- FAIL_TO_PASS: sklearn/metrics/cluster/tests/test_supervised.py::test_int_overflow_mutual_info_fowlkes_mallows_score
- gold test files: sklearn/metrics/cluster/tests/test_supervised.py
- agent modified: sklearn/metrics/cluster/supervised.py
- gold asserts (0):

## scikit-learn__scikit-learn-10908
- FAIL_TO_PASS: sklearn/feature_extraction/tests/test_text.py::test_feature_names
- gold test files: sklearn/feature_extraction/tests/test_text.py
- agent modified: sklearn/feature_extraction/text.py
- gold asserts (0):

## scikit-learn__scikit-learn-11310
- FAIL_TO_PASS: sklearn/model_selection/tests/test_search.py::test_search_cv_timing
- gold test files: sklearn/model_selection/tests/test_search.py
- agent modified: sklearn/model_selection/_search.py
- gold asserts (0):

## scikit-learn__scikit-learn-11578
- FAIL_TO_PASS: sklearn/linear_model/tests/test_logistic.py::test_logistic_cv_multinomial_score[neg_log_loss-multiclass_agg_list3]
- gold test files: sklearn/linear_model/tests/test_logistic.py
- agent modified: sklearn/linear_model/logistic.py
- gold asserts (0):

## scikit-learn__scikit-learn-12585
- FAIL_TO_PASS: sklearn/tests/test_base.py::test_clone_estimator_types
- gold test files: sklearn/tests/test_base.py
- agent modified: sklearn/base.py
- gold asserts (0):

## scikit-learn__scikit-learn-12973
- FAIL_TO_PASS: sklearn/linear_model/tests/test_least_angle.py::test_lasso_lars_fit_copyX_behaviour[False]
- gold test files: sklearn/linear_model/tests/test_least_angle.py
- agent modified: sklearn/linear_model/least_angle.py
- gold asserts (0):

## scikit-learn__scikit-learn-13124
- FAIL_TO_PASS: sklearn/model_selection/tests/test_split.py::test_shuffle_stratifiedkfold
- gold test files: sklearn/model_selection/tests/test_split.py
- agent modified: doc/whats_new/v0.21.rst, sklearn/model_selection/_split.py
- gold asserts (0):

## scikit-learn__scikit-learn-13142
- FAIL_TO_PASS: sklearn/mixture/tests/test_bayesian_mixture.py::test_bayesian_mixture_fit_predict_n_init; sklearn/mixture/tests/test_gaussian_mixture.py::test_gaussian_mixture_fit_predict_n_init
- gold test files: sklearn/mixture/tests/test_bayesian_mixture.py, sklearn/mixture/tests/test_gaussian_mixture.py
- agent modified: sklearn/mixture/base.py
- gold asserts (0):

## scikit-learn__scikit-learn-25102
- FAIL_TO_PASS: sklearn/feature_selection/tests/test_base.py::test_output_dataframe; sklearn/feature_selection/tests/test_feature_select.py::test_dataframe_output_dtypes
- gold test files: sklearn/feature_selection/tests/test_base.py, sklearn/feature_selection/tests/test_feature_select.py
- agent modified: doc/whats_new/v1.3.rst, sklearn/base.py, sklearn/feature_selection/_base.py
- gold asserts (0):

## scikit-learn__scikit-learn-25232
- FAIL_TO_PASS: sklearn/impute/tests/test_impute.py::test_iterative_imputer_constant_fill_value
- gold test files: sklearn/impute/tests/test_impute.py
- agent modified: doc/whats_new/v1.3.rst, sklearn/impute/_iterative.py
- gold asserts (0):

## scikit-learn__scikit-learn-25747
- FAIL_TO_PASS: sklearn/utils/tests/test_set_output.py::test_set_output_pandas_keep_index
- gold test files: sklearn/utils/tests/test_set_output.py
- agent modified: sklearn/utils/_set_output.py
- gold asserts (0):

## scikit-learn__scikit-learn-25931
- FAIL_TO_PASS: sklearn/ensemble/tests/test_iforest.py::test_iforest_preserve_feature_names
- gold test files: sklearn/ensemble/tests/test_iforest.py
- agent modified: sklearn/ensemble/_iforest.py
- gold asserts (0):

## scikit-learn__scikit-learn-25973
- FAIL_TO_PASS: sklearn/feature_selection/tests/test_sequential.py::test_cv_generator_support
- gold test files: sklearn/feature_selection/tests/test_sequential.py
- agent modified: sklearn/feature_selection/_sequential.py
- gold asserts (0):

## scikit-learn__scikit-learn-26194
- FAIL_TO_PASS: sklearn/metrics/tests/test_ranking.py::test_roc_curve_drop_intermediate; sklearn/metrics/tests/test_ranking.py::test_roc_curve_with_probablity_estimates[42]
- gold test files: sklearn/metrics/tests/test_ranking.py
- agent modified: doc/modules/model_evaluation.rst, doc/whats_new/v1.3.rst, sklearn/metrics/_ranking.py
- gold asserts (0):

## scikit-learn__scikit-learn-26323
- FAIL_TO_PASS: sklearn/compose/tests/test_column_transformer.py::test_remainder_set_output
- gold test files: sklearn/compose/tests/test_column_transformer.py
- agent modified: sklearn/compose/_column_transformer.py
- gold asserts (0):

## sphinx-doc__sphinx-10323
- FAIL_TO_PASS: tests/test_directive_code.py::test_LiteralIncludeReader_dedent_and_append_and_prepend
- gold test files: tests/test_directive_code.py
- agent modified: CHANGES, sphinx/directives/code.py
- gold asserts (0):

## sphinx-doc__sphinx-10435
- FAIL_TO_PASS: tests/test_build_latex.py::test_latex_code_role
- gold test files: tests/test_build_latex.py
- agent modified: sphinx/writers/latex.py
- gold asserts (0):

## sphinx-doc__sphinx-7440
- FAIL_TO_PASS: tests/test_domain_std.py::test_glossary
- gold test files: tests/test_domain_std.py
- agent modified: CHANGES, sphinx/domains/std.py
- gold asserts (0):

## sphinx-doc__sphinx-7454
- FAIL_TO_PASS: tests/test_domain_py.py::test_parse_annotation
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-7462
- FAIL_TO_PASS: tests/test_domain_py.py::test_parse_annotation; tests/test_pycode_ast.py::test_unparse[()-()]
- gold test files: tests/test_domain_py.py, tests/test_pycode_ast.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-7590
- FAIL_TO_PASS: tests/test_domain_cpp.py::test_expressions
- gold test files: tests/test_domain_cpp.py
- agent modified: sphinx/domains/cpp.py
- gold asserts (0):

## sphinx-doc__sphinx-7748
- FAIL_TO_PASS: tests/test_ext_autodoc_configs.py::test_autoclass_content_and_docstring_signature_init; tests/test_ext_autodoc_configs.py::test_autoclass_content_and_docstring_signature_both
- gold test files: tests/roots/test-ext-autodoc/target/docstring_signature.py, tests/test_ext_autodoc_configs.py
- agent modified: sphinx/ext/autodoc/__init__.py
- gold asserts (0):

## sphinx-doc__sphinx-7757
- FAIL_TO_PASS: tests/test_util_inspect.py::test_signature_from_str_positionaly_only_args
- gold test files: tests/test_util_inspect.py
- agent modified: sphinx/util/inspect.py
- gold asserts (0):

## sphinx-doc__sphinx-7889
- FAIL_TO_PASS: tests/test_ext_autodoc_mock.py::test_MockObject
- gold test files: tests/test_ext_autodoc_mock.py
- agent modified: CHANGES, sphinx/ext/autodoc/mock.py
- gold asserts (0):

## sphinx-doc__sphinx-7910
- FAIL_TO_PASS: tests/test_ext_napoleon.py::SkipMemberTest::test_class_decorated_doc
- gold test files: sphinx/testing/util.py, tests/test_ext_napoleon.py
- agent modified: sphinx/ext/napoleon/__init__.py
- gold asserts (0):

## sphinx-doc__sphinx-7985
- FAIL_TO_PASS: tests/test_build_linkcheck.py::test_defaults; tests/test_build_linkcheck.py::test_anchors_ignored
- gold test files: tests/roots/test-linkcheck/links.txt, tests/test_build_linkcheck.py
- agent modified: sphinx/builders/linkcheck.py
- gold asserts (0):

## sphinx-doc__sphinx-8035
- FAIL_TO_PASS: tests/test_ext_autodoc_private_members.py::test_private_members
- gold test files: tests/test_ext_autodoc_private_members.py
- agent modified: CHANGES, doc/usage/extensions/autodoc.rst, sphinx/ext/autodoc/__init__.py
- gold asserts (0):

## sphinx-doc__sphinx-8056
- FAIL_TO_PASS: tests/test_ext_napoleon_docstring.py::NumpyDocstringTest::test_multiple_parameters
- gold test files: tests/test_ext_napoleon_docstring.py
- agent modified: sphinx/util/docfields.py
- gold asserts (2):
  - `self.assertEqual(expected, actual)`
  - `self.assertEqual(expected, actual)`

## sphinx-doc__sphinx-8120
- FAIL_TO_PASS: tests/test_intl.py::test_customize_system_message
- gold test files: tests/test_intl.py
- agent modified: sphinx/application.py
- gold asserts (0):

## sphinx-doc__sphinx-8265
- FAIL_TO_PASS: tests/test_pycode_ast.py::test_unparse[(1,
- gold test files: tests/test_pycode_ast.py
- agent modified: sphinx/pycode/ast.py
- gold asserts (0):

## sphinx-doc__sphinx-8269
- FAIL_TO_PASS: tests/test_build_linkcheck.py::test_raises_for_invalid_status
- gold test files: tests/roots/test-linkcheck-localserver/conf.py, tests/roots/test-linkcheck-localserver/index.rst, tests/test_build_linkcheck.py
- agent modified: sphinx/builders/linkcheck.py
- gold asserts (0):

## sphinx-doc__sphinx-8459
- FAIL_TO_PASS: tests/test_ext_autodoc_configs.py::test_autodoc_typehints_description_and_type_aliases
- gold test files: tests/test_ext_autodoc_configs.py
- agent modified: sphinx/ext/autodoc/typehints.py
- gold asserts (0):

## sphinx-doc__sphinx-8475
- FAIL_TO_PASS: tests/test_build_linkcheck.py::test_TooManyRedirects_on_HEAD
- gold test files: tests/test_build_linkcheck.py
- agent modified: sphinx/builders/linkcheck.py
- gold asserts (0):

## sphinx-doc__sphinx-8548
- FAIL_TO_PASS: tests/test_ext_autodoc_autoclass.py::test_inherited_instance_variable
- gold test files: tests/roots/test-ext-autodoc/target/instance_variable.py, tests/test_ext_autodoc_autoclass.py
- agent modified: sphinx/ext/autodoc/__init__.py, sphinx/ext/autodoc/importer.py
- gold asserts (0):

## sphinx-doc__sphinx-8551
- FAIL_TO_PASS: tests/test_domain_py.py::test_info_field_list
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-8593
- FAIL_TO_PASS: tests/test_ext_autodoc_private_members.py::test_private_field; tests/test_ext_autodoc_private_members.py::test_private_members
- gold test files: tests/roots/test-ext-autodoc/target/private.py, tests/test_ext_autodoc_private_members.py
- agent modified: sphinx/ext/autodoc/__init__.py
- gold asserts (0):

## sphinx-doc__sphinx-8595
- FAIL_TO_PASS: tests/test_ext_autodoc_automodule.py::test_empty_all
- gold test files: tests/roots/test-ext-autodoc/target/empty_all.py, tests/test_ext_autodoc_automodule.py
- agent modified: sphinx/ext/autodoc/__init__.py
- gold asserts (0):

## sphinx-doc__sphinx-8621
- FAIL_TO_PASS: tests/test_markup.py::test_inline[verify-:kbd:`Alt+^`-<p><kbd; tests/test_markup.py::test_inline[verify-:kbd:`-`-<p><kbd
- gold test files: tests/test_markup.py
- agent modified: sphinx/builders/html/transforms.py
- gold asserts (0):

## sphinx-doc__sphinx-8638
- FAIL_TO_PASS: tests/test_domain_py.py::test_info_field_list_var
- gold test files: tests/test_domain_py.py
- agent modified: CHANGES, sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-8721
- FAIL_TO_PASS: tests/test_ext_viewcode.py::test_viewcode_epub_default
- gold test files: tests/test_ext_viewcode.py
- agent modified: sphinx/ext/viewcode.py
- gold asserts (0):

## sphinx-doc__sphinx-9230
- FAIL_TO_PASS: tests/test_domain_py.py::test_info_field_list
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/util/docfields.py
- gold asserts (0):

## sphinx-doc__sphinx-9258
- FAIL_TO_PASS: tests/test_domain_py.py::test_info_field_list_piped_type
- gold test files: tests/test_domain_py.py
- agent modified: CHANGES, sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-9281
- FAIL_TO_PASS: tests/test_util_inspect.py::test_object_description_enum
- gold test files: tests/test_util_inspect.py
- agent modified: sphinx/util/inspect.py
- gold asserts (0):

## sphinx-doc__sphinx-9320
- FAIL_TO_PASS: tests/test_quickstart.py::test_exits_when_existing_confpy
- gold test files: tests/test_quickstart.py
- agent modified: sphinx/cmd/quickstart.py
- gold asserts (0):

## sphinx-doc__sphinx-9367
- FAIL_TO_PASS: tests/test_pycode_ast.py::test_unparse[(1,)-(1,)]
- gold test files: tests/test_pycode_ast.py
- agent modified: sphinx/pycode/ast.py
- gold asserts (0):

## sphinx-doc__sphinx-9461
- FAIL_TO_PASS: tests/test_domain_py.py::test_pyproperty; tests/test_ext_autodoc_autoclass.py::test_properties; tests/test_ext_autodoc_autoproperty.py::test_class_properties
- gold test files: tests/roots/test-ext-autodoc/target/properties.py, tests/test_domain_py.py, tests/test_ext_autodoc_autoclass.py, tests/test_ext_autodoc_autoproperty.py
- agent modified: sphinx/domains/python.py, sphinx/ext/autodoc/__init__.py, sphinx/util/inspect.py
- gold asserts (0):

## sphinx-doc__sphinx-9591
- FAIL_TO_PASS: tests/test_domain_py.py::test_pyproperty
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-9602
- FAIL_TO_PASS: tests/test_domain_py.py::test_parse_annotation_Literal
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-9673
- FAIL_TO_PASS: tests/test_ext_autodoc_configs.py::test_autodoc_typehints_description_no_undoc
- gold test files: tests/test_ext_autodoc_configs.py
- agent modified: sphinx/ext/autodoc/typehints.py
- gold asserts (0):

## sphinx-doc__sphinx-9698
- FAIL_TO_PASS: tests/test_domain_py.py::test_pymethod_options
- gold test files: tests/test_domain_py.py
- agent modified: sphinx/domains/python.py
- gold asserts (0):

## sphinx-doc__sphinx-9711
- FAIL_TO_PASS: tests/test_extension.py::test_needs_extensions
- gold test files: tests/test_extension.py
- agent modified: sphinx/extension.py
- gold asserts (0):

## sympy__sympy-11618
- FAIL_TO_PASS: test_issue_11617
- gold test files: sympy/geometry/tests/test_point.py
- agent modified: sympy/geometry/point.py
- gold asserts (0):

## sympy__sympy-12096
- FAIL_TO_PASS: test_issue_12092
- gold test files: sympy/utilities/tests/test_lambdify.py
- agent modified: sympy/core/function.py
- gold asserts (0):

## sympy__sympy-12419
- FAIL_TO_PASS: test_Identity
- gold test files: sympy/matrices/expressions/tests/test_matexpr.py
- agent modified: sympy/concrete/delta.py, sympy/functions/special/tensor_functions.py, sympy/matrices/expressions/matexpr.py
- gold asserts (0):

## sympy__sympy-12481
- FAIL_TO_PASS: test_args
- gold test files: sympy/combinatorics/tests/test_permutations.py
- agent modified: sympy/combinatorics/permutations.py
- gold asserts (0):

## sympy__sympy-12489
- FAIL_TO_PASS: test_Permutation_subclassing
- gold test files: sympy/combinatorics/tests/test_permutations.py
- agent modified: sympy/combinatorics/permutations.py
- gold asserts (0):

## sympy__sympy-13031
- FAIL_TO_PASS: test_sparse_matrix
- gold test files: sympy/matrices/tests/test_sparse.py
- agent modified: sympy/matrices/sparse.py
- gold asserts (0):

## sympy__sympy-13091
- FAIL_TO_PASS: test_equality; test_comparisons_with_unknown_type
- gold test files: sympy/core/tests/test_basic.py, sympy/core/tests/test_numbers.py
- agent modified: sympy/core/basic.py, sympy/core/expr.py, sympy/core/numbers.py
- gold asserts (0):

## sympy__sympy-13372
- FAIL_TO_PASS: test_evalf_bugs
- gold test files: sympy/core/tests/test_evalf.py
- agent modified: sympy/core/evalf.py
- gold asserts (0):

## sympy__sympy-13480
- FAIL_TO_PASS: test_coth
- gold test files: sympy/functions/elementary/tests/test_hyperbolic.py
- agent modified: sympy/functions/elementary/hyperbolic.py
- gold asserts (0):

## sympy__sympy-13551
- FAIL_TO_PASS: test_issue_13546
- gold test files: sympy/concrete/tests/test_products.py
- agent modified: sympy/concrete/products.py
- gold asserts (0):

## sympy__sympy-13615
- FAIL_TO_PASS: test_Complement
- gold test files: sympy/sets/tests/test_sets.py
- agent modified: sympy/sets/sets.py
- gold asserts (0):

## sympy__sympy-13647
- FAIL_TO_PASS: test_col_insert
- gold test files: sympy/matrices/tests/test_commonmatrix.py
- agent modified: sympy/matrices/common.py
- gold asserts (0):

## sympy__sympy-13757
- FAIL_TO_PASS: test_issue_13079
- gold test files: sympy/core/tests/test_match.py, sympy/polys/tests/test_polytools.py
- agent modified: sympy/polys/polytools.py
- gold asserts (0):

## sympy__sympy-13798
- FAIL_TO_PASS: test_latex_basic
- gold test files: sympy/printing/tests/test_latex.py
- agent modified: sympy/printing/latex.py
- gold asserts (0):

## sympy__sympy-13852
- FAIL_TO_PASS: test_polylog_values
- gold test files: sympy/functions/special/tests/test_zeta_functions.py
- agent modified: sympy/functions/special/zeta_functions.py
- gold asserts (0):

## sympy__sympy-13877
- FAIL_TO_PASS: test_determinant
- gold test files: sympy/matrices/tests/test_matrices.py
- agent modified: sympy/matrices/matrices.py
- gold asserts (0):

## sympy__sympy-13878
- FAIL_TO_PASS: test_arcsin
- gold test files: sympy/stats/tests/test_continuous_rv.py
- agent modified: sympy/stats/crv_types.py
- gold asserts (0):

## sympy__sympy-13974
- FAIL_TO_PASS: test_tensor_product_simp
- gold test files: sympy/physics/quantum/tests/test_tensorproduct.py
- agent modified: sympy/physics/quantum/tensorproduct.py
- gold asserts (0):

## sympy__sympy-14531
- FAIL_TO_PASS: test_python_relational; test_Rational
- gold test files: sympy/printing/tests/test_python.py, sympy/printing/tests/test_str.py
- agent modified: sympy/printing/str.py
- gold asserts (0):

## sympy__sympy-14711
- FAIL_TO_PASS: test_Vector
- gold test files: sympy/physics/vector/tests/test_vector.py
- agent modified: sympy/physics/vector/vector.py
- gold asserts (0):

## sympy__sympy-14976
- FAIL_TO_PASS: test_MpmathPrinter
- gold test files: sympy/printing/tests/test_pycode.py, sympy/solvers/tests/test_numeric.py
- agent modified: sympy/printing/pycode.py
- gold asserts (0):

## sympy__sympy-15017
- FAIL_TO_PASS: test_ndim_array_initiation
- gold test files: sympy/tensor/array/tests/test_immutable_ndim_array.py
- agent modified: sympy/tensor/array/dense_ndim_array.py, sympy/tensor/array/sparse_ndim_array.py
- gold asserts (0):

## sympy__sympy-15345
- FAIL_TO_PASS: test_Function
- gold test files: sympy/printing/tests/test_mathematica.py
- agent modified: sympy/printing/mathematica.py
- gold asserts (0):

## sympy__sympy-15349
- FAIL_TO_PASS: test_quaternion_conversions
- gold test files: sympy/algebras/tests/test_quaternion.py
- agent modified: sympy/algebras/quaternion.py
- gold asserts (0):

## sympy__sympy-15599
- FAIL_TO_PASS: test_Mod
- gold test files: sympy/core/tests/test_arit.py
- agent modified: sympy/core/mod.py
- gold asserts (0):

## sympy__sympy-15809
- FAIL_TO_PASS: test_Min; test_Max
- gold test files: sympy/functions/elementary/tests/test_miscellaneous.py
- agent modified: sympy/functions/elementary/miscellaneous.py
- gold asserts (0):

## sympy__sympy-15875
- FAIL_TO_PASS: test_Add_is_zero
- gold test files: sympy/core/tests/test_arit.py
- agent modified: sympy/core/add.py
- gold asserts (0):

## sympy__sympy-15976
- FAIL_TO_PASS: test_presentation_symbol
- gold test files: sympy/printing/tests/test_mathml.py
- agent modified: sympy/printing/mathml.py
- gold asserts (0):

## sympy__sympy-16450
- FAIL_TO_PASS: test_posify
- gold test files: sympy/simplify/tests/test_simplify.py
- agent modified: sympy/simplify/simplify.py
- gold asserts (0):

## sympy__sympy-16597
- FAIL_TO_PASS: test_infinity; test_neg_infinity; test_other_symbol
- gold test files: sympy/core/tests/test_assumptions.py, sympy/functions/elementary/tests/test_miscellaneous.py
- agent modified: sympy/assumptions/ask.py, sympy/assumptions/ask_generated.py, sympy/core/assumptions.py, sympy/core/power.py, sympy/printing/tree.py, sympy/tensor/indexed.py
- gold asserts (0):

## sympy__sympy-16766
- FAIL_TO_PASS: test_PythonCodePrinter
- gold test files: sympy/printing/tests/test_pycode.py
- agent modified: sympy/printing/pycode.py
- gold asserts (0):

## sympy__sympy-16792
- FAIL_TO_PASS: test_ccode_unused_array_arg
- gold test files: sympy/utilities/tests/test_codegen.py
- agent modified: sympy/utilities/codegen.py
- gold asserts (0):

## sympy__sympy-16886
- FAIL_TO_PASS: test_encode_morse
- gold test files: sympy/crypto/tests/test_crypto.py
- agent modified: sympy/crypto/crypto.py
- gold asserts (0):

## sympy__sympy-17139
- FAIL_TO_PASS: test__TR56; test_issue_17137
- gold test files: sympy/simplify/tests/test_fu.py, sympy/simplify/tests/test_simplify.py
- agent modified: sympy/simplify/fu.py
- gold asserts (0):

## sympy__sympy-17318
- FAIL_TO_PASS: test_issue_12420
- gold test files: sympy/simplify/tests/test_sqrtdenest.py
- agent modified: sympy/simplify/radsimp.py
- gold asserts (0):

## sympy__sympy-17630
- FAIL_TO_PASS: test_issue_17624; test_zero_matrix_add
- gold test files: sympy/matrices/expressions/tests/test_blockmatrix.py, sympy/matrices/expressions/tests/test_matadd.py
- agent modified: sympy/matrices/expressions/matexpr.py
- gold asserts (0):

## sympy__sympy-17655
- FAIL_TO_PASS: test_point; test_point3D
- gold test files: sympy/geometry/tests/test_point.py
- agent modified: sympy/geometry/point.py
- gold asserts (0):

## sympy__sympy-18189
- FAIL_TO_PASS: test_diophantine
- gold test files: sympy/solvers/tests/test_diophantine.py
- agent modified: sympy/solvers/diophantine.py
- gold asserts (0):

## sympy__sympy-18199
- FAIL_TO_PASS: test_solve_modular
- gold test files: sympy/ntheory/tests/test_residue.py, sympy/solvers/tests/test_solveset.py
- agent modified: sympy/ntheory/residue_ntheory.py
- gold asserts (0):

## sympy__sympy-18211
- FAIL_TO_PASS: test_issue_18188
- gold test files: sympy/core/tests/test_relational.py
- agent modified: sympy/core/relational.py
- gold asserts (0):

## sympy__sympy-18698
- FAIL_TO_PASS: test_factor_terms
- gold test files: sympy/polys/tests/test_polytools.py
- agent modified: sympy/polys/polytools.py
- gold asserts (0):

## sympy__sympy-18763
- FAIL_TO_PASS: test_latex_subs
- gold test files: sympy/printing/tests/test_latex.py
- agent modified: sympy/printing/latex.py
- gold asserts (0):

## sympy__sympy-19040
- FAIL_TO_PASS: test_issue_5786
- gold test files: sympy/polys/tests/test_polytools.py
- agent modified: sympy/polys/sqfreetools.py
- gold asserts (0):

## sympy__sympy-19346
- FAIL_TO_PASS: test_dict
- gold test files: sympy/printing/tests/test_repr.py
- agent modified: sympy/printing/repr.py
- gold asserts (0):

## sympy__sympy-19495
- FAIL_TO_PASS: test_subs_CondSet
- gold test files: sympy/sets/tests/test_conditionset.py
- agent modified: sympy/sets/conditionset.py
- gold asserts (0):

## sympy__sympy-19637
- FAIL_TO_PASS: test_kernS
- gold test files: sympy/core/tests/test_sympify.py
- agent modified: sympy/core/sympify.py
- gold asserts (0):

## sympy__sympy-19783
- FAIL_TO_PASS: test_dagger_mul; test_identity
- gold test files: sympy/physics/quantum/tests/test_dagger.py, sympy/physics/quantum/tests/test_operator.py
- agent modified: sympy/physics/quantum/dagger.py, sympy/physics/quantum/operator.py
- gold asserts (0):

## sympy__sympy-19954
- FAIL_TO_PASS: test_sylow_subgroup
- gold test files: sympy/combinatorics/tests/test_perm_groups.py
- agent modified: sympy/combinatorics/perm_groups.py
- gold asserts (0):

## sympy__sympy-20154
- FAIL_TO_PASS: test_partitions; test_uniq
- gold test files: sympy/utilities/tests/test_iterables.py
- agent modified: sympy/utilities/iterables.py
- gold asserts (0):

## sympy__sympy-20428
- FAIL_TO_PASS: test_issue_20427
- gold test files: sympy/polys/tests/test_polytools.py
- agent modified: sympy/polys/densearith.py
- gold asserts (0):

## sympy__sympy-20590
- FAIL_TO_PASS: test_immutable
- gold test files: sympy/core/tests/test_basic.py
- agent modified: sympy/core/_print_helpers.py
- gold asserts (0):

## sympy__sympy-20801
- FAIL_TO_PASS: test_zero_not_false
- gold test files: sympy/core/tests/test_numbers.py
- agent modified: sympy/core/numbers.py
- gold asserts (0):

## sympy__sympy-20916
- FAIL_TO_PASS: test_super_sub
- gold test files: sympy/printing/tests/test_conventions.py, sympy/testing/quality_unicode.py
- agent modified: sympy/printing/conventions.py
- gold asserts (0):

## sympy__sympy-21379
- FAIL_TO_PASS: test_Mod
- gold test files: sympy/core/tests/test_arit.py
- agent modified: sympy/core/mod.py
- gold asserts (0):

## sympy__sympy-21596
- FAIL_TO_PASS: test_imageset_intersect_real
- gold test files: sympy/sets/tests/test_fancysets.py
- agent modified: sympy/sets/handlers/intersection.py
- gold asserts (0):

## sympy__sympy-21612
- FAIL_TO_PASS: test_Mul
- gold test files: sympy/printing/tests/test_str.py
- agent modified: sympy/printing/str.py
- gold asserts (0):

## sympy__sympy-21847
- FAIL_TO_PASS: test_monomials
- gold test files: sympy/polys/tests/test_monomials.py
- agent modified: sympy/polys/monomials.py
- gold asserts (0):

## sympy__sympy-21930
- FAIL_TO_PASS: test_create; test_commutation; test_create_f; test_NO; test_Tensors; test_issue_19661
- gold test files: sympy/physics/tests/test_secondquant.py
- agent modified: sympy/physics/secondquant.py
- gold asserts (0):

## sympy__sympy-22080
- FAIL_TO_PASS: test_create_expand_pow_optimization; test_PythonCodePrinter; test_empty_modules
- gold test files: sympy/codegen/tests/test_rewriting.py, sympy/printing/tests/test_pycode.py, sympy/utilities/tests/test_lambdify.py
- agent modified: sympy/printing/codeprinter.py, sympy/printing/precedence.py
- gold asserts (0):

## sympy__sympy-22456
- FAIL_TO_PASS: test_String
- gold test files: sympy/codegen/tests/test_ast.py
- agent modified: sympy/codegen/ast.py, sympy/core/basic.py
- gold asserts (0):

## sympy__sympy-22714
- FAIL_TO_PASS: test_issue_22684
- gold test files: sympy/geometry/tests/test_point.py
- agent modified: sympy/geometry/point.py
- gold asserts (0):

## sympy__sympy-22914
- FAIL_TO_PASS: test_PythonCodePrinter
- gold test files: sympy/printing/tests/test_pycode.py
- agent modified: sympy/printing/pycode.py
- gold asserts (0):

## sympy__sympy-23262
- FAIL_TO_PASS: test_issue_14941
- gold test files: sympy/utilities/tests/test_lambdify.py
- agent modified: sympy/utilities/lambdify.py
- gold asserts (0):

## sympy__sympy-23413
- FAIL_TO_PASS: test_hermite_normal
- gold test files: sympy/matrices/tests/test_normalforms.py, sympy/polys/matrices/tests/test_normalforms.py
- agent modified: sympy/polys/matrices/normalforms.py
- gold asserts (0):

## sympy__sympy-23534
- FAIL_TO_PASS: test_symbols
- gold test files: sympy/core/tests/test_symbol.py
- agent modified: sympy/core/symbol.py
- gold asserts (0):

## sympy__sympy-23824
- FAIL_TO_PASS: test_kahane_simplify1
- gold test files: sympy/physics/hep/tests/test_gamma_matrices.py
- agent modified: sympy/physics/hep/gamma_matrices.py
- gold asserts (0):

## sympy__sympy-23950
- FAIL_TO_PASS: test_as_set
- gold test files: sympy/sets/tests/test_contains.py
- agent modified: sympy/sets/contains.py
- gold asserts (0):

## sympy__sympy-24066
- FAIL_TO_PASS: test_issue_24062
- gold test files: sympy/physics/units/tests/test_quantities.py
- agent modified: sympy/physics/units/unitsystem.py
- gold asserts (0):

## sympy__sympy-24213
- FAIL_TO_PASS: test_issue_24211
- gold test files: sympy/physics/units/tests/test_quantities.py
- agent modified: sympy/physics/units/unitsystem.py
- gold asserts (0):

## sympy__sympy-24443
- FAIL_TO_PASS: test_homomorphism
- gold test files: sympy/combinatorics/tests/test_homomorphisms.py
- agent modified: sympy/combinatorics/homomorphisms.py
- gold asserts (0):

## sympy__sympy-24539
- FAIL_TO_PASS: test_PolyElement_as_expr
- gold test files: sympy/polys/tests/test_rings.py
- agent modified: sympy/polys/rings.py
- gold asserts (0):

## sympy__sympy-24562
- FAIL_TO_PASS: test_issue_24543
- gold test files: sympy/core/tests/test_numbers.py
- agent modified: sympy/core/numbers.py
- gold asserts (0):

## sympy__sympy-24661
- FAIL_TO_PASS: test_issue_24288
- gold test files: sympy/parsing/tests/test_sympy_parser.py
- agent modified: sympy/parsing/sympy_parser.py
- gold asserts (0):


_Audited 239 tasks (had both gold test assertions and an agent patch)._
