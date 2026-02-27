/* REXX ----------------------------------------------------------------- */
/*  RECMENU - Menu driven record processor                                */
/*                                                                         */
/*  Features                                                               */
/*   - Interactive menu UI (screens)                                       */
/*   - Config file read (optional)                                         */
/*   - Logging                                                             */
/*   - Load records from dataset DD or USS file                            */
/*   - Parse/validate fixed-format record                                 */
/*   - Filter, sort, stats                                                 */
/*   - Export results                                                      */
/*                                                                         */
/*  Install                                                                */
/*   - Put into a REXX library and allocate to SYSPROC/SYSEXEC             */
/*   - Allocate input dataset to DD: INDD (or set in config)               */
/*                                                                         */
/* ---------------------------------------------------------------------- */

signal on syntax name TrapSyntax
signal on error  name TrapError
signal on halt   name TrapHalt

/* ----------------------- Globals / Defaults --------------------------- */
appName    = "RECMENU"
appVer     = "1.0"
cfgDD      = "CFGDD"
inDD       = "INDD"
outDD      = "OUTDD"
logDD      = "LOGDD"

say
say appName "v"appVer

call InitGlobals
call LoadConfig  /* optional; safe if DD not allocated */
call EnsureLog

/* Main loop */
do forever
  call ShowHeader
  choice = MainMenu()
  select
    when choice = "1" then call Action_LoadRecords
    when choice = "2" then call Action_SetFilter
    when choice = "3" then call Action_Sort
    when choice = "4" then call Action_ShowStats
    when choice = "5" then call Action_BrowseSample
    when choice = "6" then call Action_Export
    when choice = "7" then call Action_ClearAll
    when choice = "X" | choice = "x" then leave
    otherwise do
      call Msg "Invalid choice. Try again."
    end
  end
end

call Msg "Exiting. Bye."
exit 0

/* ===================================================================== */
/*                            UI / MENUS                                  */
/* ===================================================================== */

ShowHeader:
  say "------------------------------------------------------------"
  say appName "Record Processor   |  Loaded:" loadedCount ,
      "  Filtered:" viewCount "  Invalid:" invalidCount
  say "Input:" inputSource
  if filterActive then say "Filter:" filterDesc
  else say "Filter: (none)"
  say "------------------------------------------------------------"
return

MainMenu: procedure
  say
  say "1) Load records"
  say "2) Set/clear filter"
  say "3) Sort view"
  say "4) Show stats"
  say "5) Browse sample records"
  say "6) Export view"
  say "7) Clear all"
  say "X) Exit"
  pull ans
  ans = strip(ans)
return ans

Msg: procedure expose logEnabled
  parse arg text
  say text
  if logEnabled then call Log text
return

Prompt: procedure
  parse arg p, def
  if def <> "" then say p "("def"):"
  else say p":"
  pull a
  a = strip(a)
  if a = "" then a = def
return a

WaitKey: procedure
  say "Press ENTER to continue..."
  pull .
return

/* ===================================================================== */
/*                           CONFIG / LOG                                 */
/* ===================================================================== */

InitGlobals:
  loadedCount  = 0
  viewCount    = 0
  invalidCount = 0
  filterActive = 0
  filterDesc   = ""
  sortKey      = ""
  sortOrder    = "A" /* A or D */
  inputSource  = inDD /* default DD */
  inputMode    = "DD" /* DD or USS */
  inputUSS     = ""
  exportMode   = "DD" /* DD or USS */
  exportUSS    = ""
  logEnabled   = 1
  logMode      = "DD"
  logUSS       = ""
  drop rec. view. idx.
return

LoadConfig:
  /* Optional: read key=value pairs from cfgDD */
  if \IsDDAllocated(cfgDD) then do
    call Msg "Config DD not allocated; using defaults."
    return
  end

  call Msg "Loading config from DD:" cfgDD
  "EXECIO * DISKR" cfgDD "(STEM cfg. FINIS"
  if rc <> 0 then do
    call Msg "Warning: could not read config. RC="rc
    return
  end

  do i = 1 to cfg.0
    line = strip(cfg.i)
    if line = "" then iterate
    if left(line,1) = "#" then iterate
    parse var line k "=" v
    k = strip(translate(k))
    v = strip(v)
    select
      when k="INPUTMODE" then inputMode = translate(v)
      when k="INPUTDD"   then inputSource = v
      when k="INPUTUSS"  then inputUSS = v
      when k="LOGENABLED" then logEnabled = (translate(v)="Y")
      when k="LOGMODE"   then logMode = translate(v)
      when k="LOGDD"     then logDD = v
      when k="LOGUSS"    then logUSS = v
      when k="EXPORTMODE" then exportMode = translate(v)
      when k="EXPORTDD"   then outDD = v
      when k="EXPORTUSS"  then exportUSS = v
      otherwise nop
    end
  end

return

EnsureLog:
  if \logEnabled then return
  /* If log mode is DD, only log if DD allocated */
  if logMode="DD" then do
    if \IsDDAllocated(logDD) then do
      logEnabled = 0
      say "Logging disabled (LOGDD not allocated)."
    end
  end
return

Log: procedure expose logMode logDD logUSS
  parse arg text
  ts = Timestamp()
  line = ts " " text
  if logMode="DD" then do
    /* Append to DD */
    "EXECIO 1 DISKW" logDD "(STRING" line
  end
  else do
    /* USS logging (optional). Not all environments allow this. */
    /* If you want USS log, you can use ADDRESS SYSCALLS and write() */
    nop
  end
return

Timestamp: procedure
  /* Basic timestamp, local time */
  parse value date('S') with y 5 m 7 d 9
  parse value time('L') with hh 1 2 ":" mm 4 2 ":" ss 7 2
return y"-"m"-"d" "hh":"mm":"ss

IsDDAllocated: procedure
  /* Returns 1 if allocated, 0 if not */
  parse arg dd
  "LISTDSI" dd
  if rc=0 & sysdsorg<>"" then return 1
return 0

/* ===================================================================== */
/*                          RECORD ACTIONS                                */
/* ===================================================================== */

Action_LoadRecords:
  call Msg "Load records selected."
  /* choose source */
  mode = Prompt("Input mode (DD/USS)", inputMode)
  mode = translate(mode)
  if mode<>"DD" & mode<>"USS" then do
    call Msg "Invalid mode. Using DD."
    mode="DD"
  end
  inputMode = mode

  if inputMode="DD" then do
    ddn = Prompt("Input DD name", inputSource)
    inputSource = ddn
    if \IsDDAllocated(ddn) then do
      call Msg "DD not allocated: "ddn
      call WaitKey
      return
    end
    call LoadFromDD ddn
  end
  else do
    path = Prompt("USS path", inputUSS)
    inputUSS = path
    call LoadFromUSS path
  end

  call BuildView /* build view.= all by default */
  call WaitKey
return

LoadFromDD: procedure expose rec. loadedCount invalidCount
  parse arg ddn
  drop rec.
  loadedCount = 0
  invalidCount = 0

  call Msg "Reading from DD:" ddn
  "EXECIO * DISKR" ddn "(STEM raw. FINIS"
  if rc<>0 then do
    call Msg "Read failed. RC="rc
    return
  end

  do i=1 to raw.0
    r = raw.i
    call ParseRecord r, i
  end

  call Msg "Loaded:" loadedCount "Invalid:" invalidCount
return

LoadFromUSS: procedure expose rec. loadedCount invalidCount
  parse arg path
  drop rec.
  loadedCount = 0
  invalidCount = 0

  call Msg "USS input not implemented in this skeleton."
  call Msg "Implement via ADDRESS SYSCALLS open()/read() or use BPXBATCH."
return

ParseRecord: procedure expose rec. loadedCount invalidCount
  parse arg line, seq
  /* Parse fixed columns */
  last  = strip(substr(line,1,20))
  first = strip(substr(line,21,20))
  bdt   = strip(substr(line,41,8))
  amt   = strip(substr(line,49,10))
  st    = strip(substr(line,59,1))

  ok = 1
  err = ""

  if last="" then do; ok=0; err=err " LASTNAME"; end
  if first="" then do; ok=0; err=err " FIRSTNAME"; end
  if \IsYYYYMMDD(bdt) then do; ok=0; err=err " BIRTHDATE"; end
  if \IsNumeric(amt) then do; ok=0; err=err " AMOUNT"; end
  if st="" then do; ok=0; err=err " STATUS"; end

  idx = seq
  rec.idx.line  = line
  rec.idx.last  = last
  rec.idx.first = first
  rec.idx.bdt   = bdt
  rec.idx.amt   = amt
  rec.idx.stat  = st
  rec.idx.ok    = ok
  rec.idx.err   = strip(err)

  if ok then loadedCount = loadedCount + 1
  else invalidCount = invalidCount + 1
return

IsYYYYMMDD: procedure
  parse arg d
  if length(d)<>8 then return 0
  if \datatype(d,'N') then return 0
  y = substr(d,1,4)
  m = substr(d,5,2)
  day= substr(d,7,2)
  if m<"01" | m>"12" then return 0
  if day<"01" | day>"31" then return 0
return 1

IsNumeric: procedure
  parse arg x
  x = strip(x)
  if x="" then return 0
  /* allow leading sign */
  if left(x,1)="-" | left(x,1)="+" then x = substr(x,2)
  /* allow decimal point */
  x = translate(x, , ".")
  /* now x may have at most one '.' removed above, but we removed all '.'; just check digits left */
  if x="" then return 0
return datatype(x,'N')

/* ===================================================================== */
/*                           VIEW / FILTER                                */
/* ===================================================================== */

BuildView: procedure expose rec. view. loadedCount viewCount filterActive
  drop view.
  viewCount = 0
  /* view index list for "current selection" */
  do i=1 to 999999
    if rec.i.ok = "" then leave
    /* default: include only valid records */
    if rec.i.ok = 1 then do
      viewCount = viewCount + 1
      view.viewCount = i
    end
  end
  filterActive = 0
return

Action_SetFilter:
  if loadedCount=0 & viewCount=0 then do
    call Msg "Nothing loaded."
    call WaitKey
    return
  end

  say
  say "Filter options:"
  say "1) Status equals"
  say "2) Amount >= threshold"
  say "3) Last name starts with"
  say "4) Clear filter (show all valid)"
  pull c
  c=strip(c)

  select
    when c="1" then do
      v = Prompt("Enter status value (single char)", "")
      call ApplyFilter "STATUS", v
    end
    when c="2" then do
      v = Prompt("Enter numeric threshold", "0")
      call ApplyFilter "AMTGE", v
    end
    when c="3" then do
      v = Prompt("Enter prefix", "")
      call ApplyFilter "LASTPREFIX", v
    end
    when c="4" then do
      call BuildView
      filterActive = 0
      filterDesc = ""
      call Msg "Filter cleared."
    end
    otherwise call Msg "Invalid."
  end

  call WaitKey
return

ApplyFilter: procedure expose rec. view. viewCount filterActive filterDesc
  parse arg ftype, val
  drop view.
  viewCount = 0

  valU = translate(val)
  do i=1 to 999999
    if rec.i.ok = "" then leave
    if rec.i.ok<>1 then iterate

    keep = 0
    select
      when ftype="STATUS" then do
        if translate(rec.i.stat)=valU then keep=1
        filterDesc = "STATUS="valU
      end
      when ftype="AMTGE" then do
        if IsNumeric(val)=0 then keep=0
        else if rec.i.amt >= val then keep=1
        filterDesc = "AMOUNT>="val
      end
      when ftype="LASTPREFIX" then do
        if left(translate(rec.i.last), length(valU)) = valU then keep=1
        filterDesc = "LAST starts "valU
      end
      otherwise nop
    end

    if keep then do
      viewCount = viewCount + 1
      view.viewCount = i
    end
  end

  filterActive = 1
  call Msg "Filter applied. View count:" viewCount
return

/* ===================================================================== */
/*                                SORT                                    */
/* ===================================================================== */

Action_Sort:
  if viewCount=0 then do
    call Msg "Nothing to sort."
    call WaitKey
    return
  end

  say
  say "Sort by:"
  say "1) LAST, FIRST"
  say "2) BIRTHDATE"
  say "3) AMOUNT"
  say "Order (A/D): current="sortOrder
  pull c
  c=strip(c)
  o = Prompt("Order (A/D)", sortOrder)
  o = translate(o)
  if o<>"A" & o<>"D" then o="A"
  sortOrder = o

  select
    when c="1" then sortKey="NAME"
    when c="2" then sortKey="BDT"
    when c="3" then sortKey="AMT"
    otherwise do
      call Msg "Invalid sort."
      call WaitKey
      return
    end
  end

  call SortView sortKey, sortOrder
  call Msg "Sorted."
  call WaitKey
return

SortView: procedure expose rec. view. viewCount
  parse arg key, order

  /* Simple O(n^2) sort for skeleton purposes.
     Replace with a better sort if your views get large. */
  do i=1 to viewCount-1
    do j=i+1 to viewCount
      a = view.i
      b = view.j
      if CompareIdx(a,b,key,order) > 0 then do
        tmp = view.i
        view.i = view.j
        view.j = tmp
      end
    end
  end
return

CompareIdx: procedure expose rec.
  parse arg ia, ib, key, order

  select
    when key="NAME" then do
      ka = translate(rec.ia.last)||"|"||translate(rec.ia.first)
      kb = translate(rec.ib.last)||"|"||translate(rec.ib.first)
    end
    when key="BDT" then do
      ka = rec.ia.bdt
      kb = rec.ib.bdt
    end
    when key="AMT" then do
      ka = right(rec.ia.amt,10,"0")
      kb = right(rec.ib.amt,10,"0")
    end
    otherwise do
      ka = ia
      kb = ib
    end
  end

  /* string compare */
  if ka = kb then return 0
  if order="A" then do
    if ka > kb then return 1
    else return -1
  end
  else do
    if ka < kb then return 1
    else return -1
  end
return 0

/* ===================================================================== */
/*                               STATS                                    */
/* ===================================================================== */

Action_ShowStats:
  if viewCount=0 then do
    call Msg "No view to analyze."
    call WaitKey
    return
  end

  tot = 0
  minAmt = ""
  maxAmt = ""
  cnt = 0
  stCnt. = 0

  do i=1 to viewCount
    idx = view.i
    a = rec.idx.amt
    if \IsNumeric(a) then iterate

    cnt = cnt + 1
    tot = tot + a

    if minAmt="" | a < minAmt then minAmt=a
    if maxAmt="" | a > maxAmt then maxAmt=a

    s = rec.idx.stat
    stCnt.s = stCnt.s + 1
  end

  say
  say "View stats"
  say "---------"
  say "Records:" viewCount
  say "Numeric amount counted:" cnt
  if cnt>0 then say "Total amount:" tot
  if cnt>0 then say "Average amount:" (tot/cnt)
  say "Min amount:" minAmt
  say "Max amount:" maxAmt
  say
  say "Status counts:"
  /* naive: list A-Z plus others */
  do k=1 to 26
    ch = d2c(c2d('A')+k-1)
    if stCnt.ch>0 then say " "ch":" stCnt.ch
  end
  if stCnt.' '>0 then say " (blank):" stCnt.' '
  call WaitKey
return

/* ===================================================================== */
/*                            BROWSE SAMPLE                               */
/* ===================================================================== */

Action_BrowseSample:
  if viewCount=0 then do
    call Msg "No records loaded."
    call WaitKey
    return
  end

  n = Prompt("How many to display", "10")
  if \datatype(n,'N') then n=10
  if n>viewCount then n=viewCount
  if n<1 then n=1

  say
  say "Idx  LAST                FIRST               BDT       AMT        S"
  say "---  -------------------- ------------------- -------- ---------- -"
  do i=1 to n
    idx = view.i
    say right(idx,3) ,
        left(rec.idx.last,20) ,
        left(rec.idx.first,19) ,
        rec.idx.bdt ,
        right(rec.idx.amt,10) ,
        rec.idx.stat
  end

  call WaitKey
return

/* ===================================================================== */
/*                               EXPORT                                   */
/* ===================================================================== */

Action_Export:
  if viewCount=0 then do
    call Msg "Nothing to export."
    call WaitKey
    return
  end

  mode = Prompt("Export mode (DD/USS)", exportMode)
  mode = translate(mode)
  if mode<>"DD" & mode<>"USS" then mode="DD"
  exportMode = mode

  if exportMode="DD" then do
    ddn = Prompt("Output DD name", outDD)
    outDD = ddn
    if \IsDDAllocated(ddn) then do
      call Msg "Output DD not allocated: "ddn
      call WaitKey
      return
    end
    call ExportToDD ddn
  end
  else do
    path = Prompt("Output USS path", exportUSS)
    exportUSS = path
    call Msg "USS export not implemented in this skeleton."
  end

  call WaitKey
return

ExportToDD: procedure expose rec. view. viewCount
  parse arg ddn
  "EXECIO 0 DISKW" ddn "(OPEN"
  if rc<>0 then do
    call Msg "Could not open output. RC="rc
    return
  end

  do i=1 to viewCount
    idx = view.i
    line = rec.idx.line
    "EXECIO 1 DISKW" ddn "(STRING" line
  end

  "EXECIO 0 DISKW" ddn "(FINIS"
  call Msg "Exported "viewCount "records to DD:" ddn
return

/* ===================================================================== */
/*                              CLEAR                                     */
/* ===================================================================== */

Action_ClearAll:
  drop rec. view.
  loadedCount=0
  viewCount=0
  invalidCount=0
  filterActive=0
  filterDesc=""
  sortKey=""
  call Msg "Cleared."
  call WaitKey
return

/* ===================================================================== */
/*                              TRAPS                                     */
/* ===================================================================== */

TrapSyntax:
  say "SYNTAX error at line" sigl". RC="rc
  say "Condition:" condition('C') " Desc:" condition('D')
  exit 12

TrapError:
  say "ERROR at line" sigl". RC="rc
  say "Condition:" condition('C') " Desc:" condition('D')
  exit 12

TrapHalt:
  say "HALT received."
  exit 16