-- Phase 6: mobile consent capture and customer-readable preference state.

CREATE FUNCTION public.get_my_email_marketing_consent() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((SELECT email_opt_in AND withdrawn_at IS NULL
    FROM public.customer_marketing_preferences WHERE user_id=auth.uid()),false)
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_email_marketing_consent() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_email_marketing_consent() TO authenticated;

CREATE FUNCTION public.capture_signup_marketing_consent() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF COALESCE((NEW.raw_user_meta_data->>'marketing_email_opt_in')::BOOLEAN,false) THEN
    INSERT INTO public.customer_marketing_preferences(user_id,email_opt_in,consent_source,consented_at,withdrawn_at)
    VALUES(NEW.id,true,'registration',now(),NULL)
    ON CONFLICT(user_id) DO UPDATE SET email_opt_in=true,consent_source='registration',consented_at=now(),withdrawn_at=NULL,updated_at=now();
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  -- Malformed client metadata is ignored and therefore remains opted out.
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.capture_signup_marketing_consent() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_capture_signup_marketing_consent
AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.capture_signup_marketing_consent();
