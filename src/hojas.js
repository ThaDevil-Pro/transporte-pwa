// =====================================================================
// Lectura de listas de usuarios desde Excel (.xlsx) o CSV, sin interfaz.
// Valida con las mismas reglas que el servidor, para avisar antes de
// enviar; el servidor vuelve a validar todo.
// =====================================================================

const MAX_FILAS = 3000
const MAX_BYTES = 5 * 1024 * 1024
const MAX_XML = 40 * 1024 * 1024 // tamaño máximo de cada parte del .xlsx ya descomprimida

export const ROL_ETIQUETA = { Estudiante: 'Alumno', Chofer: 'Chofer' }

// Encabezados aceptados, ya normalizados (sin acentos, espacios ni signos)
const COLUMNAS = {
  nombre: ['nombre', 'nombres', 'nombrecompleto', 'nombredelalumno', 'nombrealumno', 'alumno', 'name'],
  apellidos: ['apellidos', 'apellido'],
  paterno: ['apellidopaterno', 'paterno', 'primerapellido'],
  materno: ['apellidomaterno', 'materno', 'segundoapellido'],
  identificador: ['matricula', 'numerodecontrol', 'nodecontrol', 'numcontrol', 'nocontrol', 'control',
    'licencia', 'numerodelicencia', 'nodelicencia', 'nolicencia', 'usuario', 'identificador', 'id'],
  password: ['contrasena', 'contrasenatemporal', 'password', 'clave'],
  saldo: ['saldo', 'saldoinicial', 'adeudo'],
  rol: ['rol', 'tipo', 'perfil']
}
const NOMBRE_COLUMNA = {
  nombre: 'Nombre', apellidos: 'Apellidos', paterno: 'Apellido paterno', materno: 'Apellido materno',
  identificador: 'Matrícula', password: 'Contraseña', saldo: 'Saldo', rol: 'Rol'
}

const sinAcentos = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
const clave = s => sinAcentos(s).toLowerCase().replace(/[^a-z0-9]/g, '')
const limpiarEspacios = s => String(s ?? '').replace(/\s+/g, ' ').trim()
export const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

// --- LECTURA DE ARCHIVOS ---

// Excel en Windows suele guardar el CSV en Windows-1252, no en UTF-8
export function decodificar(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}

export function leerCsv(texto) {
  texto = texto.replace(/^﻿/, '')
  // Separador: el que más aparece en la primera línea (Excel en español a veces usa ;)
  const primera = texto.split(/\r?\n/, 1)[0]
  const sep = [',', ';', '\t'].reduce((mejor, s) => (primera.split(s).length > primera.split(mejor).length ? s : mejor), ',')

  const filas = []
  let fila = []
  let campo = ''
  let enComillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (enComillas) {
      if (c !== '"') campo += c
      else if (texto[i + 1] === '"') { campo += '"'; i++ }
      else enComillas = false
    } else if (c === '"' && campo === '') {
      enComillas = true
    } else if (c === sep) {
      fila.push(campo)
      campo = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ''
    } else {
      campo += c
    }
  }
  if (campo !== '' || fila.length) {
    fila.push(campo)
    filas.push(fila)
  }
  return filas
}

// Un .xlsx es un ZIP con XML adentro: se lee la primera hoja
export async function leerXlsx(buffer) {
  const { unzipSync, strFromU8 } = await import('fflate')
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  let partes
  try {
    partes = unzipSync(new Uint8Array(buffer), {
      filter: f => f.originalSize <= MAX_XML && (
        f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' ||
        f.name === 'xl/sharedStrings.xml' || f.name.startsWith('xl/worksheets/'))
    })
  } catch {
    throw new Error('El archivo está dañado o no es un Excel válido.')
  }

  const xml = nombre => partes[nombre] && new DOMParser().parseFromString(strFromU8(partes[nombre]), 'application/xml')
  const porNombre = (nodo, local) => [...nodo.getElementsByTagNameNS('*', local)]

  // Ruta de la primera hoja según el libro (no siempre es sheet1.xml)
  let ruta = 'xl/worksheets/sheet1.xml'
  const libro = xml('xl/workbook.xml')
  const relaciones = xml('xl/_rels/workbook.xml.rels')
  const hoja1 = libro && porNombre(libro, 'sheet')[0]
  if (hoja1 && relaciones) {
    const rid = hoja1.getAttributeNS(NS_REL, 'id') || hoja1.getAttribute('r:id')
    const rel = porNombre(relaciones, 'Relationship').find(r => r.getAttribute('Id') === rid)
    const destino = rel?.getAttribute('Target')
    if (destino) ruta = destino.startsWith('/') ? destino.slice(1) : `xl/${destino}`
  }
  const hoja = xml(ruta)
  if (!hoja) throw new Error('No encontramos ninguna hoja con datos en el archivo.')

  const compartidos = xml('xl/sharedStrings.xml')
  const textos = compartidos
    ? porNombre(compartidos, 'si').map(si => porNombre(si, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join(''))
    : []

  const columna = ref => {
    const letras = /^[A-Z]+/.exec(ref || '')?.[0] || ''
    return [...letras].reduce((n, l) => n * 26 + l.charCodeAt(0) - 64, 0) - 1
  }

  const filas = []
  porNombre(hoja, 'row').forEach((row, orden) => {
    const num = Number(row.getAttribute('r')) || orden + 1
    const celdas = []
    porNombre(row, 'c').forEach((c, k) => {
      const col = c.getAttribute('r') ? columna(c.getAttribute('r')) : k
      const tipo = c.getAttribute('t')
      const v = porNombre(c, 'v')[0]?.textContent ?? ''
      let valor
      if (tipo === 's') valor = textos[Number(v)] ?? ''
      else if (tipo === 'inlineStr') valor = porNombre(c, 't').map(t => t.textContent).join('')
      else if (tipo === 'b') valor = v === '1' ? 'TRUE' : 'FALSE'
      else if (tipo === 'e') valor = ''
      else valor = v
      celdas[col] = valor
    })
    filas[num - 1] = Array.from(celdas, x => x ?? '')
  })
  return Array.from(filas, x => x ?? [])
}

// --- INTERPRETACIÓN ---

// Busca la fila de encabezados entre las primeras 10 (a veces hay un título arriba)
function encabezados(tabla) {
  for (let i = 0; i < Math.min(tabla.length, 10); i++) {
    const mapa = {}
    ;(tabla[i] || []).forEach((celda, col) => {
      const k = clave(celda)
      for (const [campo, alias] of Object.entries(COLUMNAS)) {
        if (mapa[campo] == null && alias.includes(k)) mapa[campo] = col
      }
    })
    const tieneNombre = mapa.nombre != null || mapa.paterno != null || mapa.apellidos != null
    if (mapa.identificador != null && tieneNombre) return { fila: i, mapa }
  }
  throw new Error('No encontramos los encabezados. La primera fila debe tener columnas como “Nombre” y “Matrícula”.')
}

function rolDe(valor) {
  const k = clave(valor)
  if (!k || ['alumno', 'alumna', 'estudiante', 'a', 'e'].includes(k)) return 'Estudiante'
  if (['chofer', 'conductor', 'operador', 'c'].includes(k)) return 'Chofer'
  return limpiarEspacios(valor)
}

// Excel guarda los números con decimales de punto flotante: 150.50000000001
function numeroLimpio(valor) {
  const s = limpiarEspacios(valor).replace(/[$,\s]/g, '')
  if (/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return String(Math.round(Number(s) * 100) / 100)
  return s
}

// Matrículas numéricas que Excel convirtió a notación científica (2.0231234E7)
function identificadorLimpio(valor) {
  const s = limpiarEspacios(valor)
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s) && Number.isSafeInteger(Number(s))) return String(Number(s))
  return s
}

// Las mismas reglas que valida el servidor
function problema(f) {
  if (f.rol !== 'Estudiante' && f.rol !== 'Chofer') return `Rol “${f.rol}” no válido: usa Alumno o Chofer`
  if (!f.identificador) return 'Falta la matrícula o licencia'
  if (!/^[A-Za-z0-9_-]{3,30}$/.test(f.identificador)) return 'La matrícula o licencia debe tener de 3 a 30 caracteres: letras, números, guion o guion bajo'
  if (!f.nombre) return 'Falta el nombre'
  if (f.nombre.length < 2 || f.nombre.length > 80) return 'El nombre debe tener entre 2 y 80 caracteres'
  if (/[<>{}\u0000-\u001f]/.test(f.nombre)) return 'El nombre contiene caracteres no permitidos'
  if (f.saldo !== '') {
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(f.saldo)) return `Saldo “${f.saldo}” no válido: usa un número como 0 o 150.50`
    if (Number(f.saldo) > 100000) return 'El saldo inicial debe estar entre $0 y $100,000'
    if (f.rol === 'Chofer' && Number(f.saldo) !== 0) return 'Los choferes no llevan saldo'
  }
  if (f.password) {
    if (f.password.length < 8) return 'La contraseña debe tener al menos 8 caracteres'
    if (new TextEncoder().encode(f.password).length > 72) return 'La contraseña es demasiado larga (máximo 72 caracteres)'
    if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(f.password) || !/\d/.test(f.password)) return 'La contraseña debe combinar letras y números'
    if (f.password.toLowerCase().includes(f.identificador.toLowerCase())) return 'La contraseña no puede contener la matrícula o licencia'
  }
  return null
}

// existentes: Set con "Estudiante:<matrícula>" y "Chofer:<licencia>" ya registrados
export function interpretar(tabla, existentes = new Set()) {
  const { fila: filaEncabezado, mapa } = encabezados(tabla)
  const celda = (fila, campo) => (mapa[campo] == null ? '' : fila[mapa[campo]] ?? '')

  const listas = []
  const errores = []
  const vistos = new Map()
  tabla.slice(filaEncabezado + 1).forEach((fila, i) => {
    if (!fila.some(c => limpiarEspacios(c))) return
    const num = filaEncabezado + i + 2
    const f = {
      fila: num,
      rol: rolDe(celda(fila, 'rol')),
      nombre: limpiarEspacios(['nombre', 'apellidos', 'paterno', 'materno'].map(c => celda(fila, c)).join(' ')),
      identificador: identificadorLimpio(celda(fila, 'identificador')),
      password: String(celda(fila, 'password') ?? '').trim(),
      saldo: numeroLimpio(celda(fila, 'saldo'))
    }
    const k = `${f.rol}:${f.identificador}`
    let error = problema(f)
    if (!error && vistos.has(k)) error = `Repetido: la fila ${vistos.get(k)} ya tiene esa ${f.rol === 'Chofer' ? 'licencia' : 'matrícula'}`
    if (!error && existentes.has(k)) error = `Ya existe un ${f.rol === 'Chofer' ? 'chofer con esa licencia' : 'alumno con esa matrícula'}`
    if (!vistos.has(k)) vistos.set(k, num)
    if (error) errores.push({ ...f, error })
    else listas.push(f)
  })

  if (listas.length + errores.length === 0) throw new Error('El archivo no tiene filas con datos debajo de los encabezados.')
  if (listas.length + errores.length > MAX_FILAS) throw new Error(`El archivo tiene más de ${MAX_FILAS} filas. Divídelo en varios archivos.`)

  const columnas = Object.keys(mapa).map(c => NOMBRE_COLUMNA[c])
  return { listas, errores, columnas }
}

export async function leerArchivo(archivo, existentes) {
  const nombre = archivo.name.toLowerCase()
  if (archivo.size > MAX_BYTES) throw new Error('El archivo pesa más de 5 MB. Deja solo las columnas necesarias o divídelo.')
  if (nombre.endsWith('.xls')) throw new Error('Ese es el formato antiguo de Excel. Ábrelo y guárdalo como .xlsx o .csv.')
  if (!nombre.endsWith('.xlsx') && !nombre.endsWith('.csv')) throw new Error('Elige un archivo .xlsx o .csv.')
  const buffer = await archivo.arrayBuffer()
  const tabla = nombre.endsWith('.xlsx') ? await leerXlsx(buffer) : leerCsv(decodificar(buffer))
  return interpretar(tabla, existentes)
}

// --- DESCARGAS ---

export function csv(filas) {
  const celda = v => {
    let s = String(v ?? '')
    // Un nombre como "=HIPERVINCULO(…)" se ejecutaría como fórmula al abrirlo en Excel
    if (/^[=+@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // BOM para que Excel reconozca los acentos
  return '﻿' + filas.map(f => f.map(celda).join(',')).join('\r\n') + '\r\n'
}

export function descargar(nombre, contenido) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
