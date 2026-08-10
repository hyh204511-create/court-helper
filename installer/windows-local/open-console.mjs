import { execFile } from 'node:child_process';

execFile('cmd.exe', ['/d', '/c', 'start', '', 'http://127.0.0.1:3000/admin/browser-control'], { windowsHide: true });
