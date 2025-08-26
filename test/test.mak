# Default goal
.PHONY: all clean help
all: build\grouped1.txt build\grouped2.txt out\done.txt pattern\file1.o double\log.txt out\concat.txt out\what_changed.txt

help:
    @echo Targets:
    @echo   all, clean
    @echo   grouped: build\grouped1.txt build\grouped2.txt (grouped, oneshell)
    @echo   double\log.txt (double-colon)
    @echo   out\done.txt (private target-specific var + .EXTRA_PREREQS)
    @echo   pattern\file1.o (pattern rule)
    @echo   out\concat.txt (order-only dir + automatic vars)
    @echo   out\what_changed.txt ($?)

# Per-target ONESHELL (your engine expects .ONESHELL prerequisites = targets)
.ONESHELL: build\grouped1.txt

# Per-target SILENT (suppresses echo for this recipe)
.SILENT: out\concat.txt

.RECIPEPREFIX = >

# Grouped targets: single recipe updates both if any is missing/stale
build\grouped1.txt build\grouped2.txt &: src\seed.txt | build
> echo grouped1 from $< > build\grouped1.txt
> echo grouped2 from $< > build\grouped2.txt

.RECIPEPREFIX =

# Double-colon rules: each rule evaluated independently
double\log.txt:: double\stamp1 | double
    echo [stamp1] >> double\log.txt
double\log.txt:: double\stamp2 | double
    echo [stamp2] >> double\log.txt

double\stamp1: | double
    echo 1 > $@
double\stamp2: | double
    echo 2 > $@

# Target-specific variables (private) and extra prerequisites
MSG = global

out\done.txt: private MSG = from-done
out\done.txt: .EXTRA_PREREQS = extra\extra.txt
out\done.txt: out\dep_msg.txt | out
    echo Done: $(MSG) + $^ > $@

# This prerequisite should not see the private MSG from out\done.txt
out\dep_msg.txt: | out
    echo Dep sees MSG='$(MSG)' > $@

extra\extra.txt: | extra
    echo extra > $@

# Pattern rule with automatic vars
pattern\%.o: src\%.txt | pattern
    rem compile $< -> $@
    copy /y $< $@ >nul

# Use automatic vars ($^, $?) and order-only directories
out\concat.txt: build\grouped1.txt build\grouped2.txt | out
    type $^ > $@

out\what_changed.txt: build\grouped1.txt build\grouped2.txt | out
    echo changed: $? > $@

# Inputs
src\seed.txt: | src
    echo seed > $@

src\file1.txt: | src
    echo file1 > $@

# Directories as real targets (order-only prereqs depend on these)
build:
    if not exist build mkdir build
out:
    if not exist out mkdir out
double:
    if not exist double mkdir double
pattern:
    if not exist pattern mkdir pattern
src:
    if not exist src mkdir src
extra:
    if not exist extra mkdir extra

clean:
    if exist build rmdir /s /q build
    if exist out rmdir /s /q out
    if exist double rmdir /s /q double
    if exist pattern rmdir /s /q pattern
    if exist src rmdir /s /q src
    if exist extra rmdir /s /q extra
    