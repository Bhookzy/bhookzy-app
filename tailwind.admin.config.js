/** Admin dashboard styles (built locally). */
const base = require('./tailwind.config.js');
module.exports = { ...base, content: ['./public/admin/index.html', './public/admin/*.js'] };
