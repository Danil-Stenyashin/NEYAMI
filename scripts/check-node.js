// Проверка версии Node.js до загрузки остального кода (node:sqlite есть начиная с 22.13 без флагов).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nДля NEYAMI нужен Node.js 22.13 или новее, а установлен ${process.versions.node}.`);
  console.error('Скачайте версию LTS с https://nodejs.org и запустите снова.\n');
  process.exit(1);
}
