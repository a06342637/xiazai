import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import jsQR from 'jsqr';

test('bundled QR encoder round trips full share and direct URLs including UTF-8',async()=>{
  const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/vendor/qrcode.js',import.meta.url),'utf8'),context);
  for(const url of ['https://xz.example.com/s/AbCdEf0123456789_-abcdefgh','https://xz.example.com/api/transfers/AbCdEf0123456789_-abcdefgh/files/0123456789_abcdefghABCDE','https://例子.测试/照片/分享?名称=你好']){
    const code=context.qrcode(0,'M');code.addData(url,'Byte');code.make();
    const count=code.getModuleCount(),cell=6,size=(count+8)*cell, pixels=new Uint8ClampedArray(size*size*4).fill(255);
    for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(code.isDark(row,col))for(let y=0;y<cell;y++)for(let x=0;x<cell;x++){const i=(((row+4)*cell+y)*size+(col+4)*cell+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
    assert.equal(jsQR(pixels,size,size)?.data,url);
  }
});
