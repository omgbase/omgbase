---
type: risk
title: Burning the shutter controller firmware fails halfway
project: cirrus
likelihood: low
impact: medium
status: open
owner: /people/ines-ferreira.md
tags: [risk, cirrus]
---

# Burning the shutter controller firmware fails halfway

Threatens [Shutter commissioning](/projects/cirrus/shutter-commissioning.md). Burning the new firmware image onto the shutter controller over the serial link fails halfway through on two of the three boards Kestrel shipped, leaving the controller unbootable until the image is burnt again from the recovery header; a bricked controller on the summit is a day's drive to fix.
