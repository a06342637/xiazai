import test from 'node:test';
import assert from 'node:assert/strict';
import {datedFiles} from '../server/util.mjs';

test('uploads get Shanghai date and separate sequential numbering for each extension',()=>{
  const timestamp=Date.parse('2026-11-14T16:01:00Z');
  const files=['weird.jpg','second.JPG','video.mp4','three.jpg','photo.png','a.zip','b.zip','README','filename.unsafe!'].map(name=>({name,id:name,size:1}));
  const result=datedFiles(files,timestamp);
  assert.deepEqual(result.map(f=>f.name),['2026-11-15_jpg1.jpg','2026-11-15_jpg2.jpg','2026-11-15_mp4_1.mp4','2026-11-15_jpg3.jpg','2026-11-15_png1.png','2026-11-15_zip1.zip','2026-11-15_zip2.zip','2026-11-15_file1','2026-11-15_file2']);
  assert.equal(result[0].originalName,'weird.jpg');assert.equal(files[0].name,'weird.jpg');assert.equal(new Set(result.map(f=>f.name)).size,result.length);
});
