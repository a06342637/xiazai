import test from 'node:test';
import assert from 'node:assert/strict';
import {originalFiles, safeName} from '../server/util.mjs';

test('uploads keep original filenames, case, Unicode and duplicate names',()=>{
  const names=['weird.jpg','second.JPG','video.mp4','项目文件夹.zip','a.zip','a.zip','README','filename.unsafe!','Ã©.txt'];
  const files=names.map((name,index)=>({name,id:String(index),size:1}));
  const result=originalFiles(files);
  assert.deepEqual(result.map(f=>f.name),names);
  assert.deepEqual(result.map(f=>f.originalName),names);
  assert.deepEqual(files.map(f=>f.name),names);
  assert.equal(safeName('Ã©.txt',false),'Ã©.txt');
  assert.equal(safeName('../项目文件夹.zip',false),'项目文件夹.zip');
});
