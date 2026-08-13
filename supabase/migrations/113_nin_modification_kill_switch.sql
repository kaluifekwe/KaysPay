-- Splits identity's one broad kill switch (2026-08-13): NIN/BVN Verify stay
-- governed by the existing 'identity' switch; NIN Modification (name/phone/
-- address correction + validation — everything that goes through nin-modify
-- and nin-validate) gets its own separate switch, so modification can be
-- turned off on its own while Verify keeps working, and vice versa.

ALTER TABLE public.service_controls DROP CONSTRAINT IF EXISTS service_controls_service_check;
ALTER TABLE public.service_controls ADD CONSTRAINT service_controls_service_check
  CHECK (service IN ('vtu','esim','foreign_number','identity','nin_modification'));

INSERT INTO public.service_controls(service) VALUES ('nin_modification')
ON CONFLICT (service) DO NOTHING;
