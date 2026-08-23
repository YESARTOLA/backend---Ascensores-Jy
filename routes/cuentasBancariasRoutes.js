const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { soloFinanzas } = require('../middleware/rbacMiddleware');
const c = require('../controllers/cuentasBancariasController');

router.use(verificarToken);
// Las cuentas bancarias de la empresa (banco, número, CCI, titular) son dato
// financiero: solo las consultan y administran los roles con esa visibilidad.
// Los consumidores que las piden de forma oportunista (filtro de reportes,
// detalle de cotización) ya toleran el 403 con su propio catch.
router.use(soloFinanzas);

router.get('/catalogos', c.catalogos);
router.get('/', c.listar);
router.post('/', c.crear);
router.put('/:id', c.actualizar);
router.delete('/:id', c.eliminar);

module.exports = router;
