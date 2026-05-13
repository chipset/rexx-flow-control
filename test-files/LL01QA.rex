/*-- rexx - Obtienene lista de paquetes en un entorno determinado ----*/
/*          para un filtro                                            */
/*-- LL01QA                                                      -----*/
/*--------------------------------------------------------------------*/
/* parametros: filtro - entorno - listapl                             */
/* filtro    : Como minimo se pasa el cam (3 caracteres)              */
/* entornos  : TEST-TESZ-ANTE-CURS-PRODPR-PRODAL-PRODCI-PRODEX        */
/* listapl   : aplicaciones permitidas (* - todas)                    */
/*--------------------------------------------------------------------*/
parse upper arg subsis ',' filtro ',' entorno ',' listapl
parse upper arg parametros
call init
/*-- Alloc de las librerias del CHM ----------------------------------*/
call allocate
call entornos
/*-- Obtengo aplicaciones dadas de alta en CHM en aplschm ------------*/
call aplicaciones_CHM
/*--------------------------------------------------------------------*/
/*-- Compruebo que aplicaciones autorizadas estan en CHM en autapl. --*/
/*--------------------------------------------------------------------*/
if listapl  = '*' then listapl  = aplschm
if index(listapl,cam) = 0 then do
   retcod = '08'
   mens   = cam 'no autorizado'
   call salir
end
/*--------------------------------------------------------------------*/
/*-- comienzo a tratar la salida -------------------------------------*/
call tratar_paquetes
/*--------------------------------------------------------------------*/
if cont = 0 then do
   retcod = '04'
   mens   = 'No hay paquetes'
   call salir
end

resultados = 'NO'
do i = 1 to cont
   select
      when entorno  = 'TEST' & level.i < 20 then call escribe
      when entorno ¬= 'TEST' then call escribe
      otherwise nop
   end
end /* do */
if resultados = 'SI' then do
   retcod = '00'
   mens   = 'Servicio completado con exito'
end
else do
   retcod = '04'
   mens   = 'No hay paquetes'
end

call salir
/*--------------------------------------------------------------------*/
salir:
   call salida
   x = outtrap(members.)
   "FREE FI(SERÑPARM xmlin xmlout"
   x = outtrap(off)
   call log
   exit
return
/*--------------------------------------------------------------------*/
init:
   subsis   = strip(subsis)
   filtro   = strip(filtro)
   filtro   = space(translate(filtro,' ','*'))
   entorno  = strip(entorno)
   listapl  = strip(listapl)
   cam      = substr(filtro,1,3)
   retcod   = ''
   mens     = ''
   drop salida.
   y = 0 /*-- contador de salida --*/
   select
      when substr(filtro,4,1) = 'Z' & entorno = 'TEST' then do
         retcod = '08'
         mens   = 'no hay paquetes camZ en TEST'
         call salir
      end
      when substr(filtro,4,1) = 'T' & entorno = 'TESZ' then do
         retcod = '08'
         mens   = 'no hay paquetes camT en TESZ'
         call salir
      end
      when length(filtro)=10 then nop
      when length(filtro)>10 then do
         retcod = '08'
         mens   = 'maximo 10 posiciones para el paquete'
         call salir
      end
      when cam = 'NEA' then nop
      when length(filtro)=3 & entorno = 'TEST' then filtro = cam || 'T'
      when length(filtro)=3 & entorno = 'TESZ' then filtro = cam || 'Z'
      otherwise filtro = filtro || '*'
   end
   if length(filtro) < 10 then filtro = filtro || '*'
return
/*--------------------------------------------------------------------*/
entornos:
/*- Obtenemos nivel de promocion y site de instalacion ---------------*/
/* entornos  No instalado: TEST - TESZ - ANTE - CURS                  */
/*           Instalado   : PRODPR - PRODAL - PRODCI - PRODEX          */
/*--------------------------------------------------------------------*/
/*-- Excepciones:               --------------------------------------*/
/*--              AXYT nivel 05 --------------------------------------*/
/*--              NEAF nivel 05 --------------------------------------*/
/*--              NEAS nivel 06 --------------------------------------*/
/*--              SPTT nivel 05 --------------------------------------*/
/*--              XYZT nivel 05 --------------------------------------*/
/*--              NEAD nivel 17 --------------------------------------*/
/*--              XXXT nivel 12 --------------------------------------*/
/*--              XXXZ nivel 13 --------------------------------------*/
/*--------------------------------------------------------------------*/
/* 1 - Approved 2 - Backout 3 - Baselined 4 - Closed 5 - Deleted */
/* 6 - Development 7 - Distributed 8 - Frozen 9 - Installed      */
   select
      when entorno = 'PRODPR' then do
         nivel = ''
         site  = 'SPRPRUE'
         estados = '39'
      end
      when entorno = 'PRODAL' then do
         nivel = ''
         site  = 'SPRALFA'
         estados = '39'
      end
      when entorno = 'PRODCI' then do
         nivel = ''
         site  = 'SPRCINF'
         estados = '39'
      end
      when entorno = 'PRODEX' then do
         nivel = ''
         site  = 'SPREXPL'
         estados = '39'
      end
      when entorno = 'TESZ' then do
         nivel = 11
         site  = ''
         estados = '12678'
      end
      when entorno = 'ANTE' then do
         nivel = 20
         site  = ''
         estados = '12678'
      end
      when entorno = 'CURS' then do
         nivel = 30
         site  = ''
         estados = '12678'
      end
      when entorno = 'TEST' then do
         nivel = ''
         site  = ''
         estados = '12678'
      end
      otherwise NOP
   end
return
/*--------------------------------------------------------------------*/
allocate:
   comcload = 'CHM.PROD.COMC.LOAD'
   tcpiport = 'CHM.PADM.TCPIPORT'
   "alloc da('"tcpiport"') fi(SERÑPARM) shr reu"
   "alloc fi(xmlin)  lrecl(255) blksize(0) recfm(v b) ",
         "cylinders space(15,15) unit(sysda) new reu"
   "alloc fi(xmlout)  lrecl(5000) blksize(0) recfm(v b) ",
         "cylinders space(15,15) unit(sysda) new reu"
return
/*-- Obtenemos todas las aplicaciones definidas en CHM              --*/
aplicaciones_CHM:
   x = 0 ; drop sal.
   x=x+1;sal.x= '<?xml version="1.0"?>'
   x=x+1;sal.x= '<service name="PARMS">'
   x=x+1;sal.x= '<scope name="APL">'
   x=x+1;sal.x= '<message name="LIST">'
   x=x+1;sal.x= '<header>'
   x=x+1;sal.x= '<subsys>P</subsys>'
   x=x+1;sal.x= '<product>CMN</product>'
   x=x+1;sal.x= '</header>'
   x=x+1;sal.x= '<request>'
   x=x+1;sal.x= '<applName></applName>'
   x=x+1;sal.x= '</request>'
   x=x+1;sal.x= '</message>'
   x=x+1;sal.x= '</scope>'
   x=x+1;sal.x= '</service>'
   sal.0 = x

   "execio "sal.0" diskw xmlin(finis stem sal."
   drop sal.
   "call '"comcload"(serxmlbc)' "
   retorno = rc
   "execio * diskr xmlout(finis stem sal."
   if retorno > 0 then do
      do i = 1 to sal.0
         y = y+1 ; salida.y = '<'sal.i'>'
      end
      call salir
   end
/*- La variable aplschm tiene todas las aplicaciones en CHM          -*/
   aplschm = ''
   DO i = 1 to sal.0
      parse var sal.i . '<applName>' vapl '</' .
      if vapl¬='' then do
         aplschm = aplschm ||' '|| vapl
      end
   end
return
/*- Tratar paquete ---------------------------------------------------*/
tratar_paquetes:
   x = 0 ; drop sal.
   x=x+1;sal.x= '<?xml version="1.0"?>'
   x=x+1;sal.x= '<service name="PACKAGE">'
   x=x+1;sal.x= '<scope name="GENERAL">'
   x=x+1;sal.x= '<message name="SEARCH">'
   x=x+1;sal.x= '<header>'
   x=x+1;sal.x= '<subsys>P</subsys>'
   x=x+1;sal.x= '<test> </test>'
   x=x+1;sal.x= '<product>CMN</product>'
   x=x+1;sal.x= '</header>'
   x=x+1;sal.x= '<request>'
   x=x+1;sal.x= '<package>'||filtro||'</package>' /* filtro con '*' */
   x=x+1;sal.x= '<siteName>'||site||'</siteName>'
   x=x+1;sal.x= '<lastPromotionLevel>'||nivel||'</lastPromotionLevel>'
   x=x+1;sal.x= '</request>'
   x=x+1;sal.x= '</message>'
   x=x+1;sal.x= '</scope>'
   x=x+1;sal.x= '</service>'
   sal.0 = x

   "execio "sal.0" diskw xmlin(finis stem sal."
   drop sal.
   "call '"comcload"(serxmlbc)' "
   retorno = rc
   "execio * diskr xmlout(finis stem sal."

/* if retorno > 0 then do
      say '<?xml version="1.0"?>'
      do i = 1 to sal.0
         say '<'sal.i'>'
      end
      say '</xml>'
      exit retorno
   end */

   drop paquete. ; paquete = ''
   drop status.  ; status  = ''
   drop creator. ; creator = ''
   drop title.   ; title   = ''
   drop level.   ; level   = ''
   etiq = ''
   cont = 0
   do i = 1 to sal.0
      graba = SI
      parse var sal.i . '<package>'v_paquete'</' .
      if v_paquete ¬= '' then paquete = v_paquete
      parse var sal.i . '<packageStatus>'v_status'</' .
      if v_status  ¬= '' then status  = v_status
      parse var sal.i . '<creator>'v_creator'</' .
      if v_creator ¬= '' then creator = v_creator
      parse var sal.i . '<packageTitle>'v_title'</' .
      if v_title   ¬= '' then title   = v_title
      parse var sal.i . '<lastPromotionLevel>'v_level'</' .
      if v_level   ¬= '' then level   = v_level

      if paquete ¬= '' & creator ¬= '' & title ¬= ''   ,
         & level¬ = '' & status  ¬= '' then do
         if index(estados,status) = 0  | level = 00 then do
            paquete = ''
            status  = ''
            creator = ''
            title   = ''
            level   = ''
            iterate
         end
         cont = cont+1
         paquete.cont = paquete
         status.cont  = status
         creator.cont = creator
         title.cont   = title
         level.cont   = level
         paquete = ''
         status  = ''
         creator = ''
         title   = ''
         level   = ''
      end
   end /* do i */

   paquete.0 = cont
   status.0  = cont
   creator.0 = cont
   title.0   = cont
   level.0   = cont

return
/*--------------------------------------------------------------------*/
escribe:
   resultados = 'SI'
   y = y+1 ; salida.y = '<package>'
   y = y+1 ; salida.y = '<name>'   || paquete.i || '</name>'
   y = y+1 ; salida.y = '<creator>'|| creator.i || '</creator>'
   y = y+1 ; salida.y = '<title>'  || title.i   || '</title>'
   y = y+1 ; salida.y = '</package>'
return
/*--------------------------------------------------------------------*/
log:
   x=LL00QA('LL01QA',date(),time(),userid(),retcod,mens,parametros)
return
/*--------------------------------------------------------------------*/
salida:
   say '<?xml version="1.0"?>'
   say '<service>'
   say '<name>ll01qa</name>'
   say '<desc>lista de paquetes en un entorno</desc>'
   say '<packlist>'
   do i = 1 to y
      say salida.i
   end
   say '</packlist>'
   say '<rc>'retcod'</rc>'
   say '<msg>'mens'</msg>'
   say '</service>'
return
