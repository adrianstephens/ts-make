# Default goal
.PHONY: all clean help
all: build\grouped1.txt build\grouped2.txt out\done.txt pattern\file1.o double\log.txt out\concat.txt out\what_changed.txt

WIN32   := $(findstring win32,$(MAKE_HOST))
REM     := $(if $(WIN32),rem,#)
COPY    := $(if $(WIN32),copy /y, mv)
TYPE    := $(if $(WIN32),type,cat)
MKDIR   := $(if $(WIN32),if not exist $$1 mkdir $$1, mkdir -p $$1)
RMDIR   := $(if $(WIN32),if exist $$1 rmdir /s /q $$1, rm -rf $$1)

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
    echo "[stamp1]" >> double\log.txt
double\log.txt:: double\stamp2 | double
    echo "[stamp2]" >> double\log.txt

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
    $(REM) compile $< -> $@
    $(COPY) $< $@

# Use automatic vars ($^, $?) and order-only directories
out\concat.txt: build\grouped1.txt build\grouped2.txt | out
    $(TYPE) $^ > $@

out\what_changed.txt: build\grouped1.txt build\grouped2.txt | out
    echo changed: $? > $@

# Inputs
src\seed.txt: | src
    echo seed > $@

src\file1.txt: | src
    echo file1 > $@

# Directories as real targets (order-only prereqs depend on these)
build:
    $(call MKDIR, build)
out:
    $(call MKDIR, out)
double:
    $(call MKDIR, double)
pattern:
    $(call MKDIR, pattern)
src:
    $(call MKDIR, src)
extra:
    $(call MKDIR, extra)

clean:
    $(call RMDIR, build)
    $(call RMDIR, out)
    $(call RMDIR, double)
    $(call RMDIR, pattern)
    $(call RMDIR, src)
    $(call RMDIR, extra)
    