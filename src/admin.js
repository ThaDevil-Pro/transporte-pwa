import { supabase } from './supabase.js'

const form = document.getElementById('alumno-form')
const inputId = document.getElementById('alumno-id')
const inputNombre = document.getElementById('nombre')
const inputMatricula = document.getElementById('matricula')
const selectEstado = document.getElementById('estado')
const btnGuardar = document.getElementById('btn-guardar')
const btnCancelar = document.getElementById('btn-cancelar')
const tabla = document.getElementById('tabla-alumnos')

// 1. Cargar lista de alumnos
async function obtenerAlumnos() {
  const { data: alumnos, error } = await supabase
    .from('alumnos')
    .select('*')
    .order('nombre', { ascending: true })

  if (error) {
    console.error('Error al obtener alumnos:', error)
    return
  }

  tabla.innerHTML = ''
  if (alumnos.length === 0) {
    tabla.innerHTML = '<tr><td colspan="4">No hay alumnos registrados.</td></tr>'
    return
  }

  alumnos.forEach(alumno => {
    const tr = document.createElement('tr')
    const badgeClass = alumno.estado === 'Activo' ? 'badge-activo' : 'badge-inactivo'

    tr.innerHTML = `
      <td>${alumno.nombre}</td>
      <td>${alumno.matricula}</td>
      <td><span class="badge ${badgeClass}">${alumno.estado || 'Activo'}</span></td>
      <td>
        <button class="btn-edit" data-id="${alumno.id}" data-nombre="${alumno.nombre}" data-matricula="${alumno.matricula}" data-estado="${alumno.estado || 'Activo'}">Editar</button>
        <button class="btn-danger" data-id="${alumno.id}">Eliminar</button>
      </td>
    `
    tabla.appendChild(tr)
  })

  asignarEventos()
}

// 2. Guardar o Actualizar Alumno
form.addEventListener('submit', async (e) => {
  e.preventDefault()

  const id = inputId.value
  const nombre = inputNombre.value
  const matricula = inputMatricula.value
  const estado = selectEstado.value

  if (id) {
    // Editar existente
    const { error } = await supabase
      .from('alumnos')
      .update({ nombre, matricula, estado })
      .eq('id', id)

    if (error) alert('Error al actualizar: ' + error.message)
  } else {
    // Crear nuevo
    const { error } = await supabase
      .from('alumnos')
      .insert([{ nombre, matricula, estado }])

    if (error) alert('Error al registrar: ' + error.message)
  }

  limpiarFormulario()
  obtenerAlumnos()
})

// 3. Asignar botones Editar y Eliminar
function asignarEventos() {
  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      inputId.value = btn.dataset.id
      inputNombre.value = btn.dataset.nombre
      inputMatricula.value = btn.dataset.matricula
      selectEstado.value = btn.dataset.estado
      btnGuardar.textContent = 'Actualizar Alumno'
      btnCancelar.style.display = 'inline-block'
    })
  })

  document.querySelectorAll('.btn-danger').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('¿Seguro que deseas eliminar este alumno?')) {
        const { error } = await supabase
          .from('alumnos')
          .delete()
          .eq('id', btn.dataset.id)

        if (error) alert('Error al borrar: ' + error.message)
        else obtenerAlumnos()
      }
    })
  })
}

// 4. Cancelar edición
btnCancelar.addEventListener('click', limpiarFormulario)

function limpiarFormulario() {
  inputId.value = ''
  inputNombre.value = ''
  inputMatricula.value = ''
  selectEstado.value = 'Activo'
  btnGuardar.textContent = 'Registrar Alumno'
  btnCancelar.style.display = 'none'
}

obtenerAlumnos()