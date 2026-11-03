export function administratorPassword(value){
  if(typeof value!=='string'||!value.length||value.length>200)throw new Error('Enter an administrator password (up to 200 characters).');
  return value;
}
