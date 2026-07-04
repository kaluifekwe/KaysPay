const { Client } = require('pg');
require('dotenv').config({ path: 'C:/Projects/KaysPay/.env' });

const client = new Client({
  connectionString: `postgresql://postgres:${process.env.SUPABASE_DB_PASSWORD}@db.xswlrzhtxrzugoxdonjc.supabase.co:5432/postgres`
});

async function run() {
  try {
    await client.connect();
    console.log('Connected');

    // Check trigger exists
    const trigger = await client.query(`
      SELECT trigger_name, event_manipulation, action_statement 
      FROM information_schema.triggers 
      WHERE trigger_name = 'on_auth_user_created';
    `);
    console.log('Trigger:', JSON.stringify(trigger.rows));

    // Check function exists
    const func = await client.query(`
      SELECT routine_name, routine_definition 
      FROM information_schema.routines 
      WHERE routine_name = 'handle_new_user';
    `);
    console.log('Function:', func.rows.length ? 'exists' : 'MISSING');

    // Check users table constraints
    const constraints = await client.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) as def
      FROM pg_constraint 
      WHERE conrelid = 'public.users'::regclass;
    `);
    console.log('Users constraints:', JSON.stringify(constraints.rows, null, 2));

    // Check users table columns
    const columns = await client.query(`
      SELECT column_name, is_nullable, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND table_schema = 'public';
    `);
    console.log('Users columns:', JSON.stringify(columns.rows, null, 2));

    // Try manually inserting into public.users to see what fails
    console.log('\nTesting manual insert...');
    try {
      await client.query(`INSERT INTO public.users (id, phone, full_name, pin_hash) VALUES (gen_random_uuid(), 'test', 'test', '')`);
      console.log('  Insert succeeded');
      // Delete the test row
      await client.query(`DELETE FROM public.users WHERE full_name = 'test'`);
    } catch (e) {
      console.log('  Insert failed:', e.message);
    }

    // Drop trigger completely
    console.log('\nDropping all triggers on auth.users...');
    await client.query(`DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS handle_new_user() CASCADE;`);
    
    // Verify dropped
    const trigger2 = await client.query(`
      SELECT trigger_name FROM information_schema.triggers 
      WHERE event_object_table = 'users' AND event_object_schema = 'auth';
    `);
    console.log('Remaining auth triggers:', JSON.stringify(trigger2.rows));

    console.log('\nDone - trigger fully removed. Try creating user now.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

run();
