# Consent clip face check

You are checking a consent clip that will be used to make a realistic digital twin of one person. The images above are frames sampled evenly from the clip, in order.

For EACH frame, in the same order, report:

- `faces`: how many human faces are visible (count faces on screens, posters and photos too).
- `face_clear`: true only if there is exactly one face and it is sharp, well lit, facing the camera, fully in frame, and not covered by hair, hands, a hat, sunglasses or tinted glasses.

Be strict: the twin can only look as real as this clip. Do not guess who the person is and do not describe them. Return one entry per frame, exactly as many entries as `frame_count`.
