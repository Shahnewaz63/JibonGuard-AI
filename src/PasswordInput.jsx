import { useState } from 'react';

export default function PasswordInput(props) {
  const [visible, setVisible] = useState(false);
  return <span style={{display:'block',position:'relative',width:'100%'}}>
    <input {...props} type={visible?'text':'password'} style={{...props.style,paddingRight:props.style?.paddingRight||'4.8em'}} />
    <button
      type="button"
      aria-label={visible?'Hide password':'Show password'}
      aria-pressed={visible}
      onClick={()=>setVisible(current=>!current)}
      style={{position:'absolute',right:'.65em',top:'50%',transform:'translateY(-50%)',border:0,background:'transparent',color:'inherit',font:'inherit',fontSize:'.82em',fontWeight:650,cursor:'pointer',padding:'.35em'}}
    >{visible?'Hide':'Show'}</button>
  </span>;
}
