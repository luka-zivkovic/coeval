-- A pre-upgrade successful test belongs to the legacy compatibility contract
-- and must not authorize native polling. Keep quarantine visible and require a
-- fresh evaluator-v1 context check.
update integrations
   set poll_enabled = false,
       last_tested_at = null,
       last_test_result = null
 where provider = 'ironside'
   and coalesce(
     (config #>> '{nativeUpgrade,requiresRevalidation}')::boolean,
     false
   ) = true;
