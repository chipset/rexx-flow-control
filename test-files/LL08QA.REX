/* REXX - lista de cams - naturaleza */
call delete_temp
call CAM
call proceso
call salir

/*-- obtiene todos los cams en allcam. -------------------------------*/
CAM:
   CL = ''
   do 6
      CL = CL||RANDOM(1,6)
   end
   libtemp = 'TMPPR.TEST.SQA.CL'||CL
   x=outtrap('novale',0)
   "delete "libtemp

   "delstack"

   job_random = ''
   do 2
      job_random = job_random||RANDOM(1,9)
   end

   queue "//CHMSQ8"||job_random||" JOB (UGASTO,CHM,OSN,VPCHM),"
   queue "//         'HERR.-PROD',MSGCLASS=X,CLASS=P,"
   queue "//         USER=&SYSUID,MSGLEVEL=(1,1)"
   queue "//PASO002  EXEC ADAPG2,BD=PRUE"
   queue "//CMPRINT  DD SYSOUT=X"
   queue "//CMWKF01  DD DSN="||libtemp||","
   queue "//             DISP=(,CATLG,DELETE),"
   queue "//             UNIT=SYSDA,SPACE=(CYL,(15,15),RLSE),"
   queue "//             RECFM=FB,LRECL=189"
   queue "//SYSIN    DD   *"
   queue "PEPN601"
   queue "/*"
   queue "//*"
   queue "//"
   queue "$$"
   x = outtrap(submit.)
   "submit * end($$)"
   x = outtrap(off)
   do q = 1 to 10
      "call *(hepwait) '00000200'" /* hhmmssdc */
      retcod = "1"
      existe_cam = sysdsn("'"libtemp"'")
      if existe_cam = "OK" then do
         retcod = "0"
         leave
      end
   end
   if retcod > 0 then do
      allcam.0 = 0
      mens = "error al generar fichero de CAM" retcod
      call salir
   end
   "alloc da('"libtemp"') fi(ALLCAM) shr reu"
   drop allcam.
   "execio * diskr allcam(finis stem allcam."
   do i = 1 to allcam.0
      allcam.i = substr(allcam.i,1,3)
   end
   x=outtrap('novale',0)
   "FREE FI(ALLCAM)"
/* x = outtrap(off) */
return
/*--------------------------------------------------------------------*/
proceso:
   do i = 1 to allcam.0
      /* Si comienza por un numero el cam se sustituye por ÑÑÑ  */
      x = datatype(substr(allcam.i,1,1),m)
      if x = 0 then allcam.i = 'ÑÑÑ'

      libdbrm = allcam.i||'PR.TEST.DBRM'
      x=outtrap('novale',0)
      "listc ent('"libdbrm"') all"
      if rc = 0 then existe_dbrm = 'OK'
      else existe_dbrm = 'KO'

      libfuen = allcam.i||'PR.TEST.FUENTE'
      x=outtrap('novale',0)
      "listc ent('"libfuen"') all"
      if rc = 0 then existe_fuen = 'OK'
      else existe_fuen = 'KO'

      /*
      say '------------------'
      say 'allcam.'i   allcam.i
      say 'valor      'value(allcam.i)
      say 'existe_dbrm'libdbrm '-' existe_dbrm
      say 'existe_fuen'libfuen '-' existe_fuen
             */

      select
         when existe_dbrm = 'OK' then do
            call check_db2
            if tabla_existe = 'SI' then x = value(allcam.i,'ZOSDB2')
            else x = value(allcam.i,'ZOS')
         end
         when existe_fuen = 'OK' then x = value(allcam.i,'ZOS')
         otherwise x = value(allcam.i,'')
      end
 /*   say 'CAM' allcam.i 'Naturaleza' value(allcam.i) */
   end
return
/*--------------------------------------------------------------------*/
delete_temp:
   junk=outtrap(line.)
   "listc level('CHM.PROD.INICIAL')"
   retcode = rc
   if retcode = 0 then do  /* fichero sin catalogar */
      do rr = 1 to line.0
         num = ''
         parse var line.rr . 'CHM.PROD.INICIAL.QA' num '.' .
         if num ¬= '' then do
            if DATATYPE(num)= 'NUM' & LENGTH(num) = 2 then do
               parse var line.rr . 'NONVSAM ------- 'fichero
               junk=outtrap(borra.)
               "delete '"fichero"'"
               junk=outtrap(off)
            end
         end
      end
   end
return
/*--------------------------------------------------------------------*/
escribir:
   cont_apl= 0
   say '<?xml version="1.0"?>'
   say '<service>'
   say '<name>ll08qa</name>'
   say '<desc>aplicacion naturaleza</desc>'
   say '<lista>'
   do i = 1 to allcam.0
      if value(allcam.i) ¬= '' then do
         cont_apl = cont_apl + 1
         say '<result>'
         say '<cam>'allcam.i'</cam>'
         say '<naturaleza>'value(allcam.i)'</naturaleza>'
         say '</result>'
      end
      mens = cont_apl 'aplicaciones'
   end
   say '</lista>'
   say '<rc>'retcod'</rc>'
   say '<msg>'mens'</msg>'
   say '</service>'
   "delete 'CHM.PROD.INICIAL.CAMNAT'"
   "alloc fi(camnat) lrecl(80) blksize(0) recfm(f b) ",
         "cylinders space(15,15) unit(sysda) new reu ",
         "da('CHM.PROD.INICIAL.CAMNAT')"
   drop allcamnat.
   allcamnat.0 = allcam.0
   do i = 1 to allcamnat.0
      allcamnat.i = 'CAM 'allcam.i '- Naturaleza' value(allcam.i)
   end
   "execio * diskw camnat(finis stem allcamnat."
   x=outtrap('novale',0)
   "FREE fi(camnat)"
/* x = outtrap(off) */
return
/*--------------------------------------------------------------------*/
salir:
   x=outtrap('novale',0)
   "delete" libtemp
   DB2 = 'ZOSDB2'
   call escribir
   x=outtrap('novale',0)
   "FREE FI(SERÑPARM xmlin xmlout"
/* x = outtrap(off) */
/* escribe el log */
   x=LL00QA('LL08QA',date(),time(),userid(),retcod,mens,parametros)
   exit
return
/*--------------------------------------------------------------------*/
check_db2:
  db2 = 'DB2T'
  cam = allcam.i
  /* cargo el entorno dsnrexx */
  address tso "subcom dsnrexx"
  if rc then
    s_rc = rxsubcom('add','dsnrexx','dsnrexx')
  /* conexion con el subsistema db2 */
  address dsnrexx "connect" db2
  if sqlcode ¬= 0 then do
     Say '*****************************************************'
     Say '  SQLCODE ='sqlcode' en CONNECT DB2' db2
     Say '*****************************************************'
  end

  /* Compruebo que exista la tabla                               */

  /* sentencia select: lectura de datos con cursor               */
     sqlstmt = ,
        "select count(*)         " ,
        "  from SYSIBM.SYSTABLES " ,
        "  where name LIKE '"||cam||"%' " ,
        "  with UR "
 /*     "  where name  IN ('PNB"||cam||"00','PNC"||cam||"00')" */

     address dsnrexx
     "execsql declare  c2 cursor for s2"
     if sqlcode ¬= 0 then do
       Say '*****************************************************'
       Say '  SQLCODE ='sqlcode' en sentencia DECLARE CURSOR'
       Say '*****************************************************'
     end
     "execsql prepare  s2 from :sqlstmt"
     if sqlcode ¬= 0 then do
       Say '*****************************************************'
       Say '  SQLCODE ='sqlcode' en sentencia PREPARE '
       Say '*****************************************************'
     end
     "execsql open     c2"
     if sqlcode ¬= 0 then do
       Say '*****************************************************'
       Say '  SQLCODE ='sqlcode' en sentencia OPEN '
       Say '*****************************************************'
     end

     zntablas= 0
     address dsnrexx
     "execsql fetch  c2 into :zntablas"
     if sqlcode ¬= 0 then do
       Say '*****************************************************'
       Say '  SQLCODE ='sqlcode' en sentencia FETCH'
       Say '*****************************************************'
     end
     address dsnrexx "execsql commit"
     /*        say 'cam ' cam 'zntablas ' zntablas  */
     tabla_existe = 'NO'
     if zntablas > 0 then do
        tabla_existe = 'SI'
     end

  /* commit y desconexión del db2 */
  address dsnrexx
  "execsql commit"
  "disconnect"

return
