const pool = require('../config/db');

/**
 * Buscar usuario por correo con su rol y permisos
 * @param {string} correo - Correo del usuario
 * @returns {Promise<Object|null>} Usuario con sus datos, rol y permisos
 */
const findUserByEmail = async (correo) => {
  const query = `
    SELECT
      u.id,
      u.nombres,
      u.correo,
      u.contrasena,
      u.id_rol,
      u.id_tecnico,
      u.acceso_servicios,
      u.acceso_proyectos,
      r.nombre AS rol,
      r.codigo AS rol_codigo,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'codigo', p.codigo,
            'nombre', p.nombre,
            'tipo', p.tipo,
            'recurso', p.recurso
          )
        ) FILTER (WHERE p.id IS NOT NULL),
        '[]'
      ) AS permisos
    FROM tbl_usuarios u
    JOIN tbl_roles r ON u.id_rol = r.id
    LEFT JOIN tbl_roles_permisos rp ON r.id = rp.id_rol AND rp.estado = 1
    LEFT JOIN tbl_permisos p ON rp.id_permiso = p.id AND p.estado = 1
    WHERE u.correo = $1
      AND u.estado = 1
    GROUP BY u.id, u.nombres, u.correo, u.contrasena, u.id_rol, u.id_tecnico, u.acceso_servicios, u.acceso_proyectos, r.nombre, r.codigo
  `;

  const result = await pool.query(query, [correo]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

const updateUltimoLogin = async (id) => {
  await pool.query(
    `UPDATE tbl_usuarios SET ultimo_login = NOW() WHERE id = $1`,
    [id]
  );
};

const findUserById = async (id) => {
  const query = `
    SELECT
      u.id, u.nombres, u.correo, u.id_rol, u.id_tecnico, u.telefono,
      u.acceso_servicios, u.acceso_proyectos,
      r.nombre AS rol, r.codigo AS rol_codigo,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'codigo', p.codigo,
            'nombre', p.nombre,
            'tipo', p.tipo,
            'recurso', p.recurso
          )
        ) FILTER (WHERE p.id IS NOT NULL),
        '[]'
      ) AS permisos
    FROM tbl_usuarios u
    JOIN tbl_roles r ON u.id_rol = r.id
    LEFT JOIN tbl_roles_permisos rp ON r.id = rp.id_rol AND rp.estado = 1
    LEFT JOIN tbl_permisos p ON rp.id_permiso = p.id AND p.estado = 1
    WHERE u.id = $1 AND u.estado = 1
    GROUP BY u.id, u.nombres, u.correo, u.id_rol, u.id_tecnico, u.telefono, u.acceso_servicios, u.acceso_proyectos, r.nombre, r.codigo
  `;
  const result = await pool.query(query, [id]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

module.exports = {
  findUserByEmail,
  findUserById,
  updateUltimoLogin
};
