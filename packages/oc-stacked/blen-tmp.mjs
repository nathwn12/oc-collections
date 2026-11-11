import { bootstrap } from './lib/bootstrap.js';
const b = bootstrap();
console.log('len=' + b.length);
const lines = b.split('\n');
lines.forEach((l, i) => console.log(String(i).padStart(2) + ' (' + l.length + ') ' + l.slice(0, 110)));
