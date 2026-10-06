(()=>{var ot=globalThis,it=ot.ShadowRoot&&(ot.ShadyCSS===void 0||ot.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,gt=Symbol(),Dt=new WeakMap,K=class{constructor(t,s,r){if(this._$cssResult$=!0,r!==gt)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=s}get styleSheet(){let t=this.o,s=this.t;if(it&&t===void 0){let r=s!==void 0&&s.length===1;r&&(t=Dt.get(s)),t===void 0&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),r&&Dt.set(s,t))}return t}toString(){return this.cssText}},Ft=e=>new K(typeof e=="string"?e:e+"",void 0,gt),v=(e,...t)=>{let s=e.length===1?e[0]:t.reduce((r,o,i)=>r+(a=>{if(a._$cssResult$===!0)return a.cssText;if(typeof a=="number")return a;throw Error("Value passed to 'css' function must be a 'css' function result: "+a+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(o)+e[i+1],e[0]);return new K(s,e,gt)},Vt=(e,t)=>{if(it)e.adoptedStyleSheets=t.map(s=>s instanceof CSSStyleSheet?s:s.styleSheet);else for(let s of t){let r=document.createElement("style"),o=ot.litNonce;o!==void 0&&r.setAttribute("nonce",o),r.textContent=s.cssText,e.appendChild(r)}},_t=it?e=>e:e=>e instanceof CSSStyleSheet?(t=>{let s="";for(let r of t.cssRules)s+=r.cssText;return Ft(s)})(e):e;var{is:Ve,defineProperty:je,getOwnPropertyDescriptor:qe,getOwnPropertyNames:We,getOwnPropertySymbols:Ge,getPrototypeOf:Ke}=Object,at=globalThis,jt=at.trustedTypes,Ye=jt?jt.emptyScript:"",Ze=at.reactiveElementPolyfillSupport,Y=(e,t)=>e,Z={toAttribute(e,t){switch(t){case Boolean:e=e?Ye:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=e!==null;break;case Number:s=e===null?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch{s=null}}return s}},nt=(e,t)=>!Ve(e,t),qt={attribute:!0,type:String,converter:Z,reflect:!1,useDefault:!1,hasChanged:nt};Symbol.metadata??=Symbol("metadata"),at.litPropertyMetadata??=new WeakMap;var k=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,s=qt){if(s.state&&(s.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((s=Object.create(s)).wrapped=!0),this.elementProperties.set(t,s),!s.noAccessor){let r=Symbol(),o=this.getPropertyDescriptor(t,r,s);o!==void 0&&je(this.prototype,t,o)}}static getPropertyDescriptor(t,s,r){let{get:o,set:i}=qe(this.prototype,t)??{get(){return this[s]},set(a){this[s]=a}};return{get:o,set(a){let n=o?.call(this);i?.call(this,a),this.requestUpdate(t,n,r)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??qt}static _$Ei(){if(this.hasOwnProperty(Y("elementProperties")))return;let t=Ke(this);t.finalize(),t.l!==void 0&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(Y("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(Y("properties"))){let s=this.properties,r=[...We(s),...Ge(s)];for(let o of r)this.createProperty(o,s[o])}let t=this[Symbol.metadata];if(t!==null){let s=litPropertyMetadata.get(t);if(s!==void 0)for(let[r,o]of s)this.elementProperties.set(r,o)}this._$Eh=new Map;for(let[s,r]of this.elementProperties){let o=this._$Eu(s,r);o!==void 0&&this._$Eh.set(o,s)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){let s=[];if(Array.isArray(t)){let r=new Set(t.flat(1/0).reverse());for(let o of r)s.unshift(_t(o))}else t!==void 0&&s.push(_t(t));return s}static _$Eu(t,s){let r=s.attribute;return r===!1?void 0:typeof r=="string"?r:typeof t=="string"?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??=new Set).add(t),this.renderRoot!==void 0&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){let t=new Map,s=this.constructor.elementProperties;for(let r of s.keys())this.hasOwnProperty(r)&&(t.set(r,this[r]),delete this[r]);t.size>0&&(this._$Ep=t)}createRenderRoot(){let t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return Vt(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,s,r){this._$AK(t,r)}_$ET(t,s){let r=this.constructor.elementProperties.get(t),o=this.constructor._$Eu(t,r);if(o!==void 0&&r.reflect===!0){let i=(r.converter?.toAttribute!==void 0?r.converter:Z).toAttribute(s,r.type);this._$Em=t,i==null?this.removeAttribute(o):this.setAttribute(o,i),this._$Em=null}}_$AK(t,s){let r=this.constructor,o=r._$Eh.get(t);if(o!==void 0&&this._$Em!==o){let i=r.getPropertyOptions(o),a=typeof i.converter=="function"?{fromAttribute:i.converter}:i.converter?.fromAttribute!==void 0?i.converter:Z;this._$Em=o;let n=a.fromAttribute(s,i.type);this[o]=n??this._$Ej?.get(o)??n,this._$Em=null}}requestUpdate(t,s,r,o=!1,i){if(t!==void 0){let a=this.constructor;if(o===!1&&(i=this[t]),r??=a.getPropertyOptions(t),!((r.hasChanged??nt)(i,s)||r.useDefault&&r.reflect&&i===this._$Ej?.get(t)&&!this.hasAttribute(a._$Eu(t,r))))return;this.C(t,s,r)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(t,s,{useDefault:r,reflect:o,wrapped:i},a){r&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,a??s??this[t]),i!==!0||a!==void 0)||(this._$AL.has(t)||(this.hasUpdated||r||(s=void 0),this._$AL.set(t,s)),o===!0&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(s){Promise.reject(s)}let t=this.scheduleUpdate();return t!=null&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[o,i]of this._$Ep)this[o]=i;this._$Ep=void 0}let r=this.constructor.elementProperties;if(r.size>0)for(let[o,i]of r){let{wrapped:a}=i,n=this[o];a!==!0||this._$AL.has(o)||n===void 0||this.C(o,void 0,i,n)}}let t=!1,s=this._$AL;try{t=this.shouldUpdate(s),t?(this.willUpdate(s),this._$EO?.forEach(r=>r.hostUpdate?.()),this.update(s)):this._$EM()}catch(r){throw t=!1,this._$EM(),r}t&&this._$AE(s)}willUpdate(t){}_$AE(t){this._$EO?.forEach(s=>s.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach(s=>this._$ET(s,this[s])),this._$EM()}updated(t){}firstUpdated(t){}};k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[Y("elementProperties")]=new Map,k[Y("finalized")]=new Map,Ze?.({ReactiveElement:k}),(at.reactiveElementVersions??=[]).push("2.1.2");var wt=globalThis,Wt=e=>e,lt=wt.trustedTypes,Gt=lt?lt.createPolicy("lit-html",{createHTML:e=>e}):void 0,$t="$lit$",L=`lit$${Math.random().toFixed(9).slice(2)}$`,xt="?"+L,Xe=`<${xt}>`,H=document,J=()=>H.createComment(""),Q=e=>e===null||typeof e!="object"&&typeof e!="function",At=Array.isArray,Qt=e=>At(e)||typeof e?.[Symbol.iterator]=="function",yt=`[ 	
\f\r]`,X=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Kt=/-->/g,Yt=/>/g,B=RegExp(`>|${yt}(?:([^\\s"'>=/]+)(${yt}*=${yt}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),Zt=/'/g,Xt=/"/g,te=/^(?:script|style|textarea|title)$/i,St=e=>(t,...s)=>({_$litType$:e,strings:t,values:s}),g=St(1),ee=St(2),se=St(3),z=Symbol.for("lit-noChange"),f=Symbol.for("lit-nothing"),Jt=new WeakMap,N=H.createTreeWalker(H,129);function re(e,t){if(!At(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return Gt!==void 0?Gt.createHTML(t):t}var oe=(e,t)=>{let s=e.length-1,r=[],o,i=t===2?"<svg>":t===3?"<math>":"",a=X;for(let n=0;n<s;n++){let l=e[n],d,p,u=-1,A=0;for(;A<l.length&&(a.lastIndex=A,p=a.exec(l),p!==null);)A=a.lastIndex,a===X?p[1]==="!--"?a=Kt:p[1]!==void 0?a=Yt:p[2]!==void 0?(te.test(p[2])&&(o=RegExp("</"+p[2],"g")),a=B):p[3]!==void 0&&(a=B):a===B?p[0]===">"?(a=o??X,u=-1):p[1]===void 0?u=-2:(u=a.lastIndex-p[2].length,d=p[1],a=p[3]===void 0?B:p[3]==='"'?Xt:Zt):a===Xt||a===Zt?a=B:a===Kt||a===Yt?a=X:(a=B,o=void 0);let E=a===B&&e[n+1].startsWith("/>")?" ":"";i+=a===X?l+Xe:u>=0?(r.push(d),l.slice(0,u)+$t+l.slice(u)+L+E):l+L+(u===-2?n:E)}return[re(e,i+(e[s]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),r]},tt=class e{constructor({strings:t,_$litType$:s},r){let o;this.parts=[];let i=0,a=0,n=t.length-1,l=this.parts,[d,p]=oe(t,s);if(this.el=e.createElement(d,r),N.currentNode=this.el.content,s===2||s===3){let u=this.el.content.firstChild;u.replaceWith(...u.childNodes)}for(;(o=N.nextNode())!==null&&l.length<n;){if(o.nodeType===1){if(o.hasAttributes())for(let u of o.getAttributeNames())if(u.endsWith($t)){let A=p[a++],E=o.getAttribute(u).split(L),M=/([.?@])?(.*)/.exec(A);l.push({type:1,index:i,name:M[2],strings:E,ctor:M[1]==="."?dt:M[1]==="?"?ht:M[1]==="@"?pt:D}),o.removeAttribute(u)}else u.startsWith(L)&&(l.push({type:6,index:i}),o.removeAttribute(u));if(te.test(o.tagName)){let u=o.textContent.split(L),A=u.length-1;if(A>0){o.textContent=lt?lt.emptyScript:"";for(let E=0;E<A;E++)o.append(u[E],J()),N.nextNode(),l.push({type:2,index:++i});o.append(u[A],J())}}}else if(o.nodeType===8)if(o.data===xt)l.push({type:2,index:i});else{let u=-1;for(;(u=o.data.indexOf(L,u+1))!==-1;)l.push({type:7,index:i}),u+=L.length-1}i++}}static createElement(t,s){let r=H.createElement("template");return r.innerHTML=t,r}};function U(e,t,s=e,r){if(t===z)return t;let o=r!==void 0?s._$Co?.[r]:s._$Cl,i=Q(t)?void 0:t._$litDirective$;return o?.constructor!==i&&(o?._$AO?.(!1),i===void 0?o=void 0:(o=new i(e),o._$AT(e,s,r)),r!==void 0?(s._$Co??=[])[r]=o:s._$Cl=o),o!==void 0&&(t=U(e,o._$AS(e,t.values),o,r)),t}var ct=class{constructor(t,s){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=s}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){let{el:{content:s},parts:r}=this._$AD,o=(t?.creationScope??H).importNode(s,!0);N.currentNode=o;let i=N.nextNode(),a=0,n=0,l=r[0];for(;l!==void 0;){if(a===l.index){let d;l.type===2?d=new V(i,i.nextSibling,this,t):l.type===1?d=new l.ctor(i,l.name,l.strings,this,t):l.type===6&&(d=new ut(i,this,t)),this._$AV.push(d),l=r[++n]}a!==l?.index&&(i=N.nextNode(),a++)}return N.currentNode=H,o}p(t){let s=0;for(let r of this._$AV)r!==void 0&&(r.strings!==void 0?(r._$AI(t,r,s),s+=r.strings.length-2):r._$AI(t[s])),s++}},V=class e{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,s,r,o){this.type=2,this._$AH=f,this._$AN=void 0,this._$AA=t,this._$AB=s,this._$AM=r,this.options=o,this._$Cv=o?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode,s=this._$AM;return s!==void 0&&t?.nodeType===11&&(t=s.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,s=this){t=U(this,t,s),Q(t)?t===f||t==null||t===""?(this._$AH!==f&&this._$AR(),this._$AH=f):t!==this._$AH&&t!==z&&this._(t):t._$litType$!==void 0?this.$(t):t.nodeType!==void 0?this.T(t):Qt(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==f&&Q(this._$AH)?this._$AA.nextSibling.data=t:this.T(H.createTextNode(t)),this._$AH=t}$(t){let{values:s,_$litType$:r}=t,o=typeof r=="number"?this._$AC(t):(r.el===void 0&&(r.el=tt.createElement(re(r.h,r.h[0]),this.options)),r);if(this._$AH?._$AD===o)this._$AH.p(s);else{let i=new ct(o,this),a=i.u(this.options);i.p(s),this.T(a),this._$AH=i}}_$AC(t){let s=Jt.get(t.strings);return s===void 0&&Jt.set(t.strings,s=new tt(t)),s}k(t){At(this._$AH)||(this._$AH=[],this._$AR());let s=this._$AH,r,o=0;for(let i of t)o===s.length?s.push(r=new e(this.O(J()),this.O(J()),this,this.options)):r=s[o],r._$AI(i),o++;o<s.length&&(this._$AR(r&&r._$AB.nextSibling,o),s.length=o)}_$AR(t=this._$AA.nextSibling,s){for(this._$AP?.(!1,!0,s);t!==this._$AB;){let r=Wt(t).nextSibling;Wt(t).remove(),t=r}}setConnected(t){this._$AM===void 0&&(this._$Cv=t,this._$AP?.(t))}},D=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,s,r,o,i){this.type=1,this._$AH=f,this._$AN=void 0,this.element=t,this.name=s,this._$AM=o,this.options=i,r.length>2||r[0]!==""||r[1]!==""?(this._$AH=Array(r.length-1).fill(new String),this.strings=r):this._$AH=f}_$AI(t,s=this,r,o){let i=this.strings,a=!1;if(i===void 0)t=U(this,t,s,0),a=!Q(t)||t!==this._$AH&&t!==z,a&&(this._$AH=t);else{let n=t,l,d;for(t=i[0],l=0;l<i.length-1;l++)d=U(this,n[r+l],s,l),d===z&&(d=this._$AH[l]),a||=!Q(d)||d!==this._$AH[l],d===f?t=f:t!==f&&(t+=(d??"")+i[l+1]),this._$AH[l]=d}a&&!o&&this.j(t)}j(t){t===f?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}},dt=class extends D{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===f?void 0:t}},ht=class extends D{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==f)}},pt=class extends D{constructor(t,s,r,o,i){super(t,s,r,o,i),this.type=5}_$AI(t,s=this){if((t=U(this,t,s,0)??f)===z)return;let r=this._$AH,o=t===f&&r!==f||t.capture!==r.capture||t.once!==r.once||t.passive!==r.passive,i=t!==f&&(r===f||o);o&&this.element.removeEventListener(this.name,this,r),i&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}},ut=class{constructor(t,s,r){this.element=t,this.type=6,this._$AN=void 0,this._$AM=s,this.options=r}get _$AU(){return this._$AM._$AU}_$AI(t){U(this,t)}},ie={M:$t,P:L,A:xt,C:1,L:oe,R:ct,D:Qt,V:U,I:V,H:D,N:ht,U:pt,B:dt,F:ut},Je=wt.litHtmlPolyfillSupport;Je?.(tt,V),(wt.litHtmlVersions??=[]).push("3.3.3");var ae=(e,t,s)=>{let r=s?.renderBefore??t,o=r._$litPart$;if(o===void 0){let i=s?.renderBefore??null;r._$litPart$=o=new V(t.insertBefore(J(),i),i,void 0,s??{})}return o._$AI(e),o};var Ct=globalThis,I=class extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){let s=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=ae(s,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return z}};I._$litElement$=!0,I.finalized=!0,Ct.litElementHydrateSupport?.({LitElement:I});var Qe=Ct.litElementPolyfillSupport;Qe?.({LitElement:I});(Ct.litElementVersions??=[]).push("4.2.2");var ne=v`
  :host {
    --divider-width: 4px;
    --divider-hit-area: 12px;
    --min: 0%;
    --max: 100%;

    display: grid;
  }

  .start,
  .end {
    overflow: hidden;
  }

  .divider {
    flex: 0 0 var(--divider-width);
    display: flex;
    position: relative;
    align-items: center;
    justify-content: center;
    background-color: var(--sl-color-neutral-200);
    color: var(--sl-color-neutral-900);
    z-index: 1;
  }

  .divider:focus {
    outline: none;
  }

  :host(:not([disabled])) .divider:focus-visible {
    background-color: var(--sl-color-primary-600);
    color: var(--sl-color-neutral-0);
  }

  :host([disabled]) .divider {
    cursor: not-allowed;
  }

  /* Horizontal */
  :host(:not([vertical], [disabled])) .divider {
    cursor: col-resize;
  }

  :host(:not([vertical])) .divider::after {
    display: flex;
    content: '';
    position: absolute;
    height: 100%;
    left: calc(var(--divider-hit-area) / -2 + var(--divider-width) / 2);
    width: var(--divider-hit-area);
  }

  /* Vertical */
  :host([vertical]) {
    flex-direction: column;
  }

  :host([vertical]:not([disabled])) .divider {
    cursor: row-resize;
  }

  :host([vertical]) .divider::after {
    content: '';
    position: absolute;
    width: 100%;
    top: calc(var(--divider-hit-area) / -2 + var(--divider-width) / 2);
    height: var(--divider-hit-area);
  }

  @media (forced-colors: active) {
    .divider {
      outline: solid 1px transparent;
    }
  }
`;function le(e,t){function s(o){let i=e.getBoundingClientRect(),a=e.ownerDocument.defaultView,n=i.left+a.scrollX,l=i.top+a.scrollY,d=o.pageX-n,p=o.pageY-l;t?.onMove&&t.onMove(d,p)}function r(){document.removeEventListener("pointermove",s),document.removeEventListener("pointerup",r),t?.onStop&&t.onStop()}document.addEventListener("pointermove",s,{passive:!0}),document.addEventListener("pointerup",r),t?.initialEvent instanceof PointerEvent&&s(t.initialEvent)}function Et(e,t,s){let r=o=>Object.is(o,-0)?0:o;return e<t?r(t):e>s?r(s):r(e)}var Tt=new Set,j=new Map,O,Pt="ltr",kt="en",ce=typeof MutationObserver<"u"&&typeof document<"u"&&typeof document.documentElement<"u";if(ce){let e=new MutationObserver(de);Pt=document.documentElement.dir||"ltr",kt=document.documentElement.lang||navigator.language,e.observe(document.documentElement,{attributes:!0,attributeFilter:["dir","lang"]})}function et(...e){e.map(t=>{let s=t.$code.toLowerCase();j.has(s)?j.set(s,Object.assign(Object.assign({},j.get(s)),t)):j.set(s,t),O||(O=t)}),de()}function de(){ce&&(Pt=document.documentElement.dir||"ltr",kt=document.documentElement.lang||navigator.language),[...Tt.keys()].map(e=>{typeof e.requestUpdate=="function"&&e.requestUpdate()})}var ft=class{constructor(t){this.host=t,this.host.addController(this)}hostConnected(){Tt.add(this.host)}hostDisconnected(){Tt.delete(this.host)}dir(){return`${this.host.dir||Pt}`.toLowerCase()}lang(){let t=`${this.host.lang||kt}`.toLowerCase().replace(/_/g,"-");try{return new Intl.Locale(t),t}catch{return O?O.$code.toLowerCase():"en"}}getTranslationData(t){var s,r;let o;try{o=new Intl.Locale(t.replace(/_/g,"-"))}catch{return{locale:void 0,language:"",region:"",primary:void 0,secondary:void 0}}let i=o.language.toLowerCase(),a=(r=(s=o.region)===null||s===void 0?void 0:s.toLowerCase())!==null&&r!==void 0?r:"",n=j.get(`${i}-${a}`),l=j.get(i);return{locale:o,language:i,region:a,primary:n,secondary:l}}exists(t,s){var r;let{primary:o,secondary:i}=this.getTranslationData((r=s.lang)!==null&&r!==void 0?r:this.lang());return s=Object.assign({includeFallback:!1},s),!!(o&&o[t]||i&&i[t]||s.includeFallback&&O&&O[t])}term(t,...s){let{primary:r,secondary:o}=this.getTranslationData(this.lang()),i;if(r&&r[t])i=r[t];else if(o&&o[t])i=o[t];else if(O&&O[t])i=O[t];else return console.error(`No translation found for: ${String(t)}`),String(t);return typeof i=="function"?i(...s):i}date(t,s){return t=new Date(t),new Intl.DateTimeFormat(this.lang(),s).format(t)}number(t,s){return t=Number(t),isNaN(t)?"":new Intl.NumberFormat(this.lang(),s).format(t)}relativeTime(t,s,r){return new Intl.RelativeTimeFormat(this.lang(),r).format(t,s)}};var he={$code:"en",$name:"English",$dir:"ltr",carousel:"Carousel",clearEntry:"Clear entry",close:"Close",copied:"Copied",copy:"Copy",currentValue:"Current value",error:"Error",goToSlide:(e,t)=>`Go to slide ${e} of ${t}`,hidePassword:"Hide password",loading:"Loading",nextSlide:"Next slide",numOptionsSelected:e=>e===0?"No options selected":e===1?"1 option selected":`${e} options selected`,previousSlide:"Previous slide",progress:"Progress",remove:"Remove",resize:"Resize",scrollToEnd:"Scroll to end",scrollToStart:"Scroll to start",selectAColorFromTheScreen:"Select a color from the screen",showPassword:"Show password",slideNum:e=>`Slide ${e}`,toggleColorFormat:"Toggle color format"};et(he);var pe=he;var q=class extends ft{};et(pe);var me=Object.defineProperty;var ts=Object.getOwnPropertyDescriptor;var ue=Object.getOwnPropertySymbols,es=Object.prototype.hasOwnProperty,ss=Object.prototype.propertyIsEnumerable;var be=e=>{throw TypeError(e)},fe=(e,t,s)=>t in e?me(e,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):e[t]=s,W=(e,t)=>{for(var s in t||(t={}))es.call(t,s)&&fe(e,s,t[s]);if(ue)for(var s of ue(t))ss.call(t,s)&&fe(e,s,t[s]);return e};var c=(e,t,s,r)=>{for(var o=r>1?void 0:r?ts(t,s):t,i=e.length-1,a;i>=0;i--)(a=e[i])&&(o=(r?a(t,s,o):a(o))||o);return r&&o&&me(t,s,o),o},ve=(e,t,s)=>t.has(e)||be("Cannot "+s),ge=(e,t,s)=>(ve(e,t,"read from private field"),s?s.call(e):t.get(e)),_e=(e,t,s)=>t.has(e)?be("Cannot add the same private member more than once"):t instanceof WeakSet?t.add(e):t.set(e,s),ye=(e,t,s,r)=>(ve(e,t,"write to private field"),r?r.call(e,s):t.set(e,s),s);function _(e,t){let s=W({waitUntilFirstUpdate:!1},t);return(r,o)=>{let{update:i}=r,a=Array.isArray(e)?e:[e];r.update=function(n){a.forEach(l=>{let d=l;if(n.has(d)){let p=n.get(d),u=this[d];p!==u&&(!s.waitUntilFirstUpdate||this.hasUpdated)&&this[o](p,u)}}),i.call(this,n)}}}var w=v`
  :host {
    box-sizing: border-box;
  }

  :host *,
  :host *::before,
  :host *::after {
    box-sizing: inherit;
  }

  [hidden] {
    display: none !important;
  }
`;var rs={attribute:!0,type:String,converter:Z,reflect:!1,hasChanged:nt},os=(e=rs,t,s)=>{let{kind:r,metadata:o}=s,i=globalThis.litPropertyMetadata.get(o);if(i===void 0&&globalThis.litPropertyMetadata.set(o,i=new Map),r==="setter"&&((e=Object.create(e)).wrapped=!0),i.set(s.name,e),r==="accessor"){let{name:a}=s;return{set(n){let l=t.get.call(this);t.set.call(this,n),this.requestUpdate(a,l,e,!0,n)},init(n){return n!==void 0&&this.C(a,void 0,e,n),n}}}if(r==="setter"){let{name:a}=s;return function(n){let l=this[a];t.call(this,n),this.requestUpdate(a,l,e,!0,n)}}throw Error("Unsupported decorator location: "+r)};function h(e){return(t,s)=>typeof s=="object"?os(e,t,s):((r,o,i)=>{let a=o.hasOwnProperty(i);return o.constructor.createProperty(i,r),a?Object.getOwnPropertyDescriptor(o,i):void 0})(e,t,s)}function R(e){return h({...e,state:!0,attribute:!1})}function we(e){return(t,s)=>{let r=typeof t=="function"?t:t[s];Object.assign(r,e)}}var F=(e,t,s)=>(s.configurable=!0,s.enumerable=!0,Reflect.decorate&&typeof t!="object"&&Object.defineProperty(e,t,s),s);function C(e,t){return(s,r,o)=>{let i=a=>a.renderRoot?.querySelector(e)??null;if(t){let{get:a,set:n}=typeof r=="object"?s:o??(()=>{let l=Symbol();return{get(){return this[l]},set(d){this[l]=d}}})();return F(s,r,{get(){let l=a.call(this);return l===void 0&&(l=i(this),(l!==null||this.hasUpdated)&&n.call(this,l)),l}})}return F(s,r,{get(){return i(this)}})}}var mt,m=class extends I{constructor(){super(),_e(this,mt,!1),this.initialReflectedProperties=new Map,Object.entries(this.constructor.dependencies).forEach(([e,t])=>{this.constructor.define(e,t)})}emit(e,t){let s=new CustomEvent(e,W({bubbles:!0,cancelable:!1,composed:!0,detail:{}},t));return this.dispatchEvent(s),s}static define(e,t=this,s={}){let r=customElements.get(e);if(!r){try{customElements.define(e,t,s)}catch{customElements.define(e,class extends t{},s)}return}let o=" (unknown version)",i=o;"version"in t&&t.version&&(o=" v"+t.version),"version"in r&&r.version&&(i=" v"+r.version),!(o&&i&&o===i)&&console.warn(`Attempted to register <${e}>${o}, but <${e}>${i} has already been registered.`)}attributeChangedCallback(e,t,s){ge(this,mt)||(this.constructor.elementProperties.forEach((r,o)=>{r.reflect&&this[o]!=null&&this.initialReflectedProperties.set(o,this[o])}),ye(this,mt,!0)),super.attributeChangedCallback(e,t,s)}willUpdate(e){super.willUpdate(e),this.initialReflectedProperties.forEach((t,s)=>{e.has(s)&&this[s]==null&&(this[s]=t)})}};mt=new WeakMap;m.version="2.20.1";m.dependencies={};c([h()],m.prototype,"dir",2);c([h()],m.prototype,"lang",2);var x=e=>e??f;var Lt=()=>null,$=class extends m{constructor(){super(...arguments),this.isCollapsed=!1,this.localize=new q(this),this.positionBeforeCollapsing=0,this.position=50,this.vertical=!1,this.disabled=!1,this.snapValue="",this.snapFunction=Lt,this.snapThreshold=12}toSnapFunction(e){let t=e.split(" ");return({pos:s,size:r,snapThreshold:o,isRtl:i,vertical:a})=>{let n=s,l=Number.POSITIVE_INFINITY;return t.forEach(d=>{let p;if(d.startsWith("repeat(")){let A=e.substring(7,e.length-1),E=A.endsWith("%"),M=Number.parseFloat(A),Ut=E?r*(M/100):M;p=Math.round((i&&!a?r-s:s)/Ut)*Ut}else d.endsWith("%")?p=r*(Number.parseFloat(d)/100):p=Number.parseFloat(d);i&&!a&&(p=r-p);let u=Math.abs(s-p);u<=o&&u<l&&(n=p,l=u)}),n}}set snap(e){this.snapValue=e??"",e?this.snapFunction=typeof e=="string"?this.toSnapFunction(e):e:this.snapFunction=Lt}get snap(){return this.snapValue}connectedCallback(){super.connectedCallback(),this.resizeObserver=new ResizeObserver(e=>this.handleResize(e)),this.updateComplete.then(()=>this.resizeObserver.observe(this)),this.detectSize(),this.cachedPositionInPixels=this.percentageToPixels(this.position)}disconnectedCallback(){var e;super.disconnectedCallback(),(e=this.resizeObserver)==null||e.unobserve(this)}detectSize(){let{width:e,height:t}=this.getBoundingClientRect();this.size=this.vertical?t:e}percentageToPixels(e){return this.size*(e/100)}pixelsToPercentage(e){return e/this.size*100}handleDrag(e){let t=this.localize.dir()==="rtl";this.disabled||(e.cancelable&&e.preventDefault(),le(this,{onMove:(s,r)=>{var o;let i=this.vertical?r:s;this.primary==="end"&&(i=this.size-i),i=(o=this.snapFunction({pos:i,size:this.size,snapThreshold:this.snapThreshold,isRtl:t,vertical:this.vertical}))!=null?o:i,this.position=Et(this.pixelsToPercentage(i),0,100)},initialEvent:e}))}handleKeyDown(e){if(!this.disabled&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","Enter"].includes(e.key)){let t=this.position,s=(e.shiftKey?10:1)*(this.primary==="end"?-1:1);if(e.preventDefault(),(e.key==="ArrowLeft"&&!this.vertical||e.key==="ArrowUp"&&this.vertical)&&(t-=s),(e.key==="ArrowRight"&&!this.vertical||e.key==="ArrowDown"&&this.vertical)&&(t+=s),e.key==="Home"&&(t=this.primary==="end"?100:0),e.key==="End"&&(t=this.primary==="end"?0:100),e.key==="Enter")if(this.isCollapsed)t=this.positionBeforeCollapsing,this.isCollapsed=!1;else{let r=this.position;t=0,requestAnimationFrame(()=>{this.isCollapsed=!0,this.positionBeforeCollapsing=r})}this.position=Et(t,0,100)}}handleResize(e){let{width:t,height:s}=e[0].contentRect;this.size=this.vertical?s:t,(isNaN(this.cachedPositionInPixels)||this.position===1/0)&&(this.cachedPositionInPixels=Number(this.getAttribute("position-in-pixels")),this.positionInPixels=Number(this.getAttribute("position-in-pixels")),this.position=this.pixelsToPercentage(this.positionInPixels)),this.primary&&(this.position=this.pixelsToPercentage(this.cachedPositionInPixels))}handlePositionChange(){this.cachedPositionInPixels=this.percentageToPixels(this.position),this.isCollapsed=!1,this.positionBeforeCollapsing=0,this.positionInPixels=this.percentageToPixels(this.position),this.emit("sl-reposition")}handlePositionInPixelsChange(){this.position=this.pixelsToPercentage(this.positionInPixels)}handleVerticalChange(){this.detectSize()}render(){let e=this.vertical?"gridTemplateRows":"gridTemplateColumns",t=this.vertical?"gridTemplateColumns":"gridTemplateRows",s=this.localize.dir()==="rtl",r=`
      clamp(
        0%,
        clamp(
          var(--min),
          ${this.position}% - var(--divider-width) / 2,
          var(--max)
        ),
        calc(100% - var(--divider-width))
      )
    `,o="auto";return this.primary==="end"?s&&!this.vertical?this.style[e]=`${r} var(--divider-width) ${o}`:this.style[e]=`${o} var(--divider-width) ${r}`:s&&!this.vertical?this.style[e]=`${o} var(--divider-width) ${r}`:this.style[e]=`${r} var(--divider-width) ${o}`,this.style[t]="",g`
      <slot name="start" part="panel start" class="start"></slot>

      <div
        part="divider"
        class="divider"
        tabindex=${x(this.disabled?void 0:"0")}
        role="separator"
        aria-valuenow=${this.position}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label=${this.localize.term("resize")}
        @keydown=${this.handleKeyDown}
        @mousedown=${this.handleDrag}
        @touchstart=${this.handleDrag}
      >
        <slot name="divider"></slot>
      </div>

      <slot name="end" part="panel end" class="end"></slot>
    `}};$.styles=[w,ne];c([C(".divider")],$.prototype,"divider",2);c([h({type:Number,reflect:!0})],$.prototype,"position",2);c([h({attribute:"position-in-pixels",type:Number})],$.prototype,"positionInPixels",2);c([h({type:Boolean,reflect:!0})],$.prototype,"vertical",2);c([h({type:Boolean,reflect:!0})],$.prototype,"disabled",2);c([h()],$.prototype,"primary",2);c([h({reflect:!0})],$.prototype,"snap",1);c([h({type:Number,attribute:"snap-threshold"})],$.prototype,"snapThreshold",2);c([_("position")],$.prototype,"handlePositionChange",1);c([_("positionInPixels")],$.prototype,"handlePositionInPixelsChange",1);c([_("vertical")],$.prototype,"handleVerticalChange",1);$.define("sl-split-panel");var $e=v`
  :host {
    --indicator-color: var(--sl-color-primary-600);
    --track-color: var(--sl-color-neutral-200);
    --track-width: 2px;

    display: block;
  }

  .tab-group {
    display: flex;
    border-radius: 0;
  }

  .tab-group__tabs {
    display: flex;
    position: relative;
  }

  .tab-group__indicator {
    position: absolute;
    transition:
      var(--sl-transition-fast) translate ease,
      var(--sl-transition-fast) width ease;
  }

  .tab-group--has-scroll-controls .tab-group__nav-container {
    position: relative;
    padding: 0 var(--sl-spacing-x-large);
  }

  .tab-group--has-scroll-controls .tab-group__scroll-button--start--hidden,
  .tab-group--has-scroll-controls .tab-group__scroll-button--end--hidden {
    visibility: hidden;
  }

  .tab-group__body {
    display: block;
    overflow: auto;
  }

  .tab-group__scroll-button {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--sl-spacing-x-large);
  }

  .tab-group__scroll-button--start {
    left: 0;
  }

  .tab-group__scroll-button--end {
    right: 0;
  }

  .tab-group--rtl .tab-group__scroll-button--start {
    left: auto;
    right: 0;
  }

  .tab-group--rtl .tab-group__scroll-button--end {
    left: 0;
    right: auto;
  }

  /*
   * Top
   */

  .tab-group--top {
    flex-direction: column;
  }

  .tab-group--top .tab-group__nav-container {
    order: 1;
  }

  .tab-group--top .tab-group__nav {
    display: flex;
    overflow-x: auto;

    /* Hide scrollbar in Firefox */
    scrollbar-width: none;
  }

  /* Hide scrollbar in Chrome/Safari */
  .tab-group--top .tab-group__nav::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .tab-group--top .tab-group__tabs {
    flex: 1 1 auto;
    position: relative;
    flex-direction: row;
    border-bottom: solid var(--track-width) var(--track-color);
  }

  .tab-group--top .tab-group__indicator {
    bottom: calc(-1 * var(--track-width));
    border-bottom: solid var(--track-width) var(--indicator-color);
  }

  .tab-group--top .tab-group__body {
    order: 2;
  }

  .tab-group--top ::slotted(sl-tab-panel) {
    --padding: var(--sl-spacing-medium) 0;
  }

  /*
   * Bottom
   */

  .tab-group--bottom {
    flex-direction: column;
  }

  .tab-group--bottom .tab-group__nav-container {
    order: 2;
  }

  .tab-group--bottom .tab-group__nav {
    display: flex;
    overflow-x: auto;

    /* Hide scrollbar in Firefox */
    scrollbar-width: none;
  }

  /* Hide scrollbar in Chrome/Safari */
  .tab-group--bottom .tab-group__nav::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .tab-group--bottom .tab-group__tabs {
    flex: 1 1 auto;
    position: relative;
    flex-direction: row;
    border-top: solid var(--track-width) var(--track-color);
  }

  .tab-group--bottom .tab-group__indicator {
    top: calc(-1 * var(--track-width));
    border-top: solid var(--track-width) var(--indicator-color);
  }

  .tab-group--bottom .tab-group__body {
    order: 1;
  }

  .tab-group--bottom ::slotted(sl-tab-panel) {
    --padding: var(--sl-spacing-medium) 0;
  }

  /*
   * Start
   */

  .tab-group--start {
    flex-direction: row;
  }

  .tab-group--start .tab-group__nav-container {
    order: 1;
  }

  .tab-group--start .tab-group__tabs {
    flex: 0 0 auto;
    flex-direction: column;
    border-inline-end: solid var(--track-width) var(--track-color);
  }

  .tab-group--start .tab-group__indicator {
    right: calc(-1 * var(--track-width));
    border-right: solid var(--track-width) var(--indicator-color);
  }

  .tab-group--start.tab-group--rtl .tab-group__indicator {
    right: auto;
    left: calc(-1 * var(--track-width));
  }

  .tab-group--start .tab-group__body {
    flex: 1 1 auto;
    order: 2;
  }

  .tab-group--start ::slotted(sl-tab-panel) {
    --padding: 0 var(--sl-spacing-medium);
  }

  /*
   * End
   */

  .tab-group--end {
    flex-direction: row;
  }

  .tab-group--end .tab-group__nav-container {
    order: 2;
  }

  .tab-group--end .tab-group__tabs {
    flex: 0 0 auto;
    flex-direction: column;
    border-left: solid var(--track-width) var(--track-color);
  }

  .tab-group--end .tab-group__indicator {
    left: calc(-1 * var(--track-width));
    border-inline-start: solid var(--track-width) var(--indicator-color);
  }

  .tab-group--end.tab-group--rtl .tab-group__indicator {
    right: calc(-1 * var(--track-width));
    left: auto;
  }

  .tab-group--end .tab-group__body {
    flex: 1 1 auto;
    order: 1;
  }

  .tab-group--end ::slotted(sl-tab-panel) {
    --padding: 0 var(--sl-spacing-medium);
  }
`;var xe=v`
  :host {
    display: contents;
  }
`;var st=class extends m{constructor(){super(...arguments),this.observedElements=[],this.disabled=!1}connectedCallback(){super.connectedCallback(),this.resizeObserver=new ResizeObserver(e=>{this.emit("sl-resize",{detail:{entries:e}})}),this.disabled||this.startObserver()}disconnectedCallback(){super.disconnectedCallback(),this.stopObserver()}handleSlotChange(){this.disabled||this.startObserver()}startObserver(){let e=this.shadowRoot.querySelector("slot");if(e!==null){let t=e.assignedElements({flatten:!0});this.observedElements.forEach(s=>this.resizeObserver.unobserve(s)),this.observedElements=[],t.forEach(s=>{this.resizeObserver.observe(s),this.observedElements.push(s)})}}stopObserver(){this.resizeObserver.disconnect()}handleDisabledChange(){this.disabled?this.stopObserver():this.startObserver()}render(){return g` <slot @slotchange=${this.handleSlotChange}></slot> `}};st.styles=[w,xe];c([h({type:Boolean,reflect:!0})],st.prototype,"disabled",2);c([_("disabled",{waitUntilFirstUpdate:!0})],st.prototype,"handleDisabledChange",1);function is(e,t){return{top:Math.round(e.getBoundingClientRect().top-t.getBoundingClientRect().top),left:Math.round(e.getBoundingClientRect().left-t.getBoundingClientRect().left)}}function zt(e,t,s="vertical",r="smooth"){let o=is(e,t),i=o.top+t.scrollTop,a=o.left+t.scrollLeft,n=t.scrollLeft,l=t.scrollLeft+t.offsetWidth,d=t.scrollTop,p=t.scrollTop+t.offsetHeight;(s==="horizontal"||s==="both")&&(a<n?t.scrollTo({left:a,behavior:r}):a+e.clientWidth>l&&t.scrollTo({left:a-t.offsetWidth+e.clientWidth,behavior:r})),(s==="vertical"||s==="both")&&(i<d?t.scrollTo({top:i,behavior:r}):i+e.clientHeight>p&&t.scrollTo({top:i-t.offsetHeight+e.clientHeight,behavior:r}))}var Ae=v`
  :host {
    display: inline-block;
    color: var(--sl-color-neutral-600);
  }

  .icon-button {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--sl-border-radius-medium);
    font-size: inherit;
    color: inherit;
    padding: var(--sl-spacing-x-small);
    cursor: pointer;
    transition: var(--sl-transition-x-fast) color;
    -webkit-appearance: none;
  }

  .icon-button:hover:not(.icon-button--disabled),
  .icon-button:focus-visible:not(.icon-button--disabled) {
    color: var(--sl-color-primary-600);
  }

  .icon-button:active:not(.icon-button--disabled) {
    color: var(--sl-color-primary-700);
  }

  .icon-button:focus {
    outline: none;
  }

  .icon-button--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon-button:focus-visible {
    outline: var(--sl-focus-ring);
    outline-offset: var(--sl-focus-ring-offset);
  }

  .icon-button__icon {
    pointer-events: none;
  }
`;var Ot="";function Se(e){Ot=e}function Ce(e=""){if(!Ot){let t=[...document.getElementsByTagName("script")],s=t.find(r=>r.hasAttribute("data-shoelace"));if(s)Se(s.getAttribute("data-shoelace"));else{let r=t.find(i=>/shoelace(\.min)?\.js($|\?)/.test(i.src)||/shoelace-autoloader(\.min)?\.js($|\?)/.test(i.src)),o="";r&&(o=r.getAttribute("src")),Se(o.split("/").slice(0,-1).join("/"))}}return Ot.replace(/\/$/,"")+(e?`/${e.replace(/^\//,"")}`:"")}var as={name:"default",resolver:e=>Ce(`assets/icons/${e}.svg`)},Ee=as;var Te={caret:`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `,check:`
    <svg part="checked-icon" class="checkbox__icon" viewBox="0 0 16 16">
      <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd" stroke-linecap="round">
        <g stroke="currentColor">
          <g transform="translate(3.428571, 3.428571)">
            <path d="M0,5.71428571 L3.42857143,9.14285714"></path>
            <path d="M9.14285714,0 L3.42857143,9.14285714"></path>
          </g>
        </g>
      </g>
    </svg>
  `,"chevron-down":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-chevron-down" viewBox="0 0 16 16">
      <path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
    </svg>
  `,"chevron-left":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-chevron-left" viewBox="0 0 16 16">
      <path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
    </svg>
  `,"chevron-right":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-chevron-right" viewBox="0 0 16 16">
      <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
    </svg>
  `,copy:`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-copy" viewBox="0 0 16 16">
      <path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2Zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6ZM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2Z"/>
    </svg>
  `,eye:`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye" viewBox="0 0 16 16">
      <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/>
      <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>
    </svg>
  `,"eye-slash":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eye-slash" viewBox="0 0 16 16">
      <path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z"/>
      <path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z"/>
      <path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .708-.708 12 12-.708.708z"/>
    </svg>
  `,eyedropper:`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-eyedropper" viewBox="0 0 16 16">
      <path d="M13.354.646a1.207 1.207 0 0 0-1.708 0L8.5 3.793l-.646-.647a.5.5 0 1 0-.708.708L8.293 5l-7.147 7.146A.5.5 0 0 0 1 12.5v1.793l-.854.853a.5.5 0 1 0 .708.707L1.707 15H3.5a.5.5 0 0 0 .354-.146L11 7.707l1.146 1.147a.5.5 0 0 0 .708-.708l-.647-.646 3.147-3.146a1.207 1.207 0 0 0 0-1.708l-2-2zM2 12.707l7-7L10.293 7l-7 7H2v-1.293z"></path>
    </svg>
  `,"grip-vertical":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-grip-vertical" viewBox="0 0 16 16">
      <path d="M7 2a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-3 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-3 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"></path>
    </svg>
  `,indeterminate:`
    <svg part="indeterminate-icon" class="checkbox__icon" viewBox="0 0 16 16">
      <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd" stroke-linecap="round">
        <g stroke="currentColor" stroke-width="2">
          <g transform="translate(2.285714, 6.857143)">
            <path d="M10.2857143,1.14285714 L1.14285714,1.14285714"></path>
          </g>
        </g>
      </g>
    </svg>
  `,"person-fill":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-person-fill" viewBox="0 0 16 16">
      <path d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H3zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
    </svg>
  `,"play-fill":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-play-fill" viewBox="0 0 16 16">
      <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"></path>
    </svg>
  `,"pause-fill":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-pause-fill" viewBox="0 0 16 16">
      <path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5zm5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"></path>
    </svg>
  `,radio:`
    <svg part="checked-icon" class="radio__icon" viewBox="0 0 16 16">
      <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
        <g fill="currentColor">
          <circle cx="8" cy="8" r="3.42857143"></circle>
        </g>
      </g>
    </svg>
  `,"star-fill":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-star-fill" viewBox="0 0 16 16">
      <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>
    </svg>
  `,"x-lg":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-x-lg" viewBox="0 0 16 16">
      <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/>
    </svg>
  `,"x-circle-fill":`
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-x-circle-fill" viewBox="0 0 16 16">
      <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"></path>
    </svg>
  `},ns={name:"system",resolver:e=>e in Te?`data:image/svg+xml,${encodeURIComponent(Te[e])}`:""},Pe=ns;var ls=[Ee,Pe],It=[];function ke(e){It.push(e)}function Le(e){It=It.filter(t=>t!==e)}function Rt(e){return ls.find(t=>t.name===e)}var ze=v`
  :host {
    display: inline-block;
    width: 1em;
    height: 1em;
    box-sizing: content-box !important;
  }

  svg {
    display: block;
    height: 100%;
    width: 100%;
  }
`;var{I:ko}=ie;var Oe=(e,t)=>t===void 0?e?._$litType$!==void 0:e?._$litType$===t;var rt=Symbol(),bt=Symbol(),Mt,Bt=new Map,T=class extends m{constructor(){super(...arguments),this.initialRender=!1,this.svg=null,this.label="",this.library="default"}async resolveIcon(e,t){var s;let r;if(t?.spriteSheet)return this.svg=g`<svg part="svg">
        <use part="use" href="${e}"></use>
      </svg>`,this.svg;try{if(r=await fetch(e,{mode:"cors"}),!r.ok)return r.status===410?rt:bt}catch{return bt}try{let o=document.createElement("div");o.innerHTML=await r.text();let i=o.firstElementChild;if(((s=i?.tagName)==null?void 0:s.toLowerCase())!=="svg")return rt;Mt||(Mt=new DOMParser);let n=Mt.parseFromString(i.outerHTML,"text/html").body.querySelector("svg");return n?(n.part.add("svg"),document.adoptNode(n)):rt}catch{return rt}}connectedCallback(){super.connectedCallback(),ke(this)}firstUpdated(){this.initialRender=!0,this.setIcon()}disconnectedCallback(){super.disconnectedCallback(),Le(this)}getIconSource(){let e=Rt(this.library);return this.name&&e?{url:e.resolver(this.name),fromLibrary:!0}:{url:this.src,fromLibrary:!1}}handleLabelChange(){typeof this.label=="string"&&this.label.length>0?(this.setAttribute("role","img"),this.setAttribute("aria-label",this.label),this.removeAttribute("aria-hidden")):(this.removeAttribute("role"),this.removeAttribute("aria-label"),this.setAttribute("aria-hidden","true"))}async setIcon(){var e;let{url:t,fromLibrary:s}=this.getIconSource(),r=s?Rt(this.library):void 0;if(!t){this.svg=null;return}let o=Bt.get(t);if(o||(o=this.resolveIcon(t,r),Bt.set(t,o)),!this.initialRender)return;let i=await o;if(i===bt&&Bt.delete(t),t===this.getIconSource().url){if(Oe(i)){if(this.svg=i,r){await this.updateComplete;let a=this.shadowRoot.querySelector("[part='svg']");typeof r.mutator=="function"&&a&&r.mutator(a)}return}switch(i){case bt:case rt:this.svg=null,this.emit("sl-error");break;default:this.svg=i.cloneNode(!0),(e=r?.mutator)==null||e.call(r,this.svg),this.emit("sl-load")}}}render(){return this.svg}};T.styles=[w,ze];c([R()],T.prototype,"svg",2);c([h({reflect:!0})],T.prototype,"name",2);c([h()],T.prototype,"src",2);c([h()],T.prototype,"label",2);c([h({reflect:!0})],T.prototype,"library",2);c([_("label")],T.prototype,"handleLabelChange",1);c([_(["name","src","library"])],T.prototype,"setIcon",1);var Ie={ATTRIBUTE:1,CHILD:2,PROPERTY:3,BOOLEAN_ATTRIBUTE:4,EVENT:5,ELEMENT:6},Re=e=>(...t)=>({_$litDirective$:e,values:t}),vt=class{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,s,r){this._$Ct=t,this._$AM=s,this._$Ci=r}_$AS(t,s){return this.update(t,s)}update(t,s){return this.render(...s)}};var P=Re(class extends vt{constructor(e){if(super(e),e.type!==Ie.ATTRIBUTE||e.name!=="class"||e.strings?.length>2)throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.")}render(e){return" "+Object.keys(e).filter(t=>e[t]).join(" ")+" "}update(e,[t]){if(this.st===void 0){this.st=new Set,e.strings!==void 0&&(this.nt=new Set(e.strings.join(" ").split(/\s/).filter(r=>r!=="")));for(let r in t)t[r]&&!this.nt?.has(r)&&this.st.add(r);return this.render(t)}let s=e.element.classList;for(let r of this.st)r in t||(s.remove(r),this.st.delete(r));for(let r in t){let o=!!t[r];o===this.st.has(r)||this.nt?.has(r)||(o?(s.add(r),this.st.add(r)):(s.remove(r),this.st.delete(r)))}return z}});var Be=Symbol.for(""),cs=e=>{if(e?.r===Be)return e?._$litStatic$};var Nt=(e,...t)=>({_$litStatic$:t.reduce((s,r,o)=>s+(i=>{if(i._$litStatic$!==void 0)return i._$litStatic$;throw Error(`Value passed to 'literal' function must be a 'literal' result: ${i}. Use 'unsafeStatic' to pass non-literal values, but
            take care to ensure page security.`)})(r)+e[o+1],e[0]),r:Be}),Me=new Map,Ht=e=>(t,...s)=>{let r=s.length,o,i,a=[],n=[],l,d=0,p=!1;for(;d<r;){for(l=t[d];d<r&&(i=s[d],(o=cs(i))!==void 0);)l+=o+t[++d],p=!0;d!==r&&n.push(i),a.push(l),d++}if(d===r&&a.push(t[r]),p){let u=a.join("$$lit$$");(t=Me.get(u))===void 0&&(a.raw=a,Me.set(u,t=a)),s=n}return e(t,...s)},Ne=Ht(g),Qo=Ht(ee),ti=Ht(se);var y=class extends m{constructor(){super(...arguments),this.hasFocus=!1,this.label="",this.disabled=!1}handleBlur(){this.hasFocus=!1,this.emit("sl-blur")}handleFocus(){this.hasFocus=!0,this.emit("sl-focus")}handleClick(e){this.disabled&&(e.preventDefault(),e.stopPropagation())}click(){this.button.click()}focus(e){this.button.focus(e)}blur(){this.button.blur()}render(){let e=!!this.href,t=e?Nt`a`:Nt`button`;return Ne`
      <${t}
        part="base"
        class=${P({"icon-button":!0,"icon-button--disabled":!e&&this.disabled,"icon-button--focused":this.hasFocus})}
        ?disabled=${x(e?void 0:this.disabled)}
        type=${x(e?void 0:"button")}
        href=${x(e?this.href:void 0)}
        target=${x(e?this.target:void 0)}
        download=${x(e?this.download:void 0)}
        rel=${x(e&&this.target?"noreferrer noopener":void 0)}
        role=${x(e?void 0:"button")}
        aria-disabled=${this.disabled?"true":"false"}
        aria-label="${this.label}"
        tabindex=${this.disabled?"-1":"0"}
        @blur=${this.handleBlur}
        @focus=${this.handleFocus}
        @click=${this.handleClick}
      >
        <sl-icon
          class="icon-button__icon"
          name=${x(this.name)}
          library=${x(this.library)}
          src=${x(this.src)}
          aria-hidden="true"
        ></sl-icon>
      </${t}>
    `}};y.styles=[w,Ae];y.dependencies={"sl-icon":T};c([C(".icon-button")],y.prototype,"button",2);c([R()],y.prototype,"hasFocus",2);c([h()],y.prototype,"name",2);c([h()],y.prototype,"library",2);c([h()],y.prototype,"src",2);c([h()],y.prototype,"href",2);c([h()],y.prototype,"target",2);c([h()],y.prototype,"download",2);c([h()],y.prototype,"label",2);c([h({type:Boolean,reflect:!0})],y.prototype,"disabled",2);var b=class extends m{constructor(){super(...arguments),this.tabs=[],this.focusableTabs=[],this.panels=[],this.localize=new q(this),this.hasScrollControls=!1,this.shouldHideScrollStartButton=!1,this.shouldHideScrollEndButton=!1,this.placement="top",this.activation="auto",this.noScrollControls=!1,this.fixedScrollControls=!1,this.scrollOffset=1}connectedCallback(){let e=Promise.all([customElements.whenDefined("sl-tab"),customElements.whenDefined("sl-tab-panel")]);super.connectedCallback(),this.resizeObserver=new ResizeObserver(()=>{this.repositionIndicator(),this.updateScrollControls()}),this.mutationObserver=new MutationObserver(t=>{let s=t.filter(({target:r})=>{if(r===this)return!0;if(r.closest("sl-tab-group")!==this)return!1;let o=r.tagName.toLowerCase();return o==="sl-tab"||o==="sl-tab-panel"});if(s.length!==0){if(s.some(r=>!["aria-labelledby","aria-controls"].includes(r.attributeName))&&setTimeout(()=>this.setAriaLabels()),s.some(r=>r.attributeName==="disabled"))this.syncTabsAndPanels();else if(s.some(r=>r.attributeName==="active")){let o=s.filter(i=>i.attributeName==="active"&&i.target.tagName.toLowerCase()==="sl-tab").map(i=>i.target).find(i=>i.active);o&&this.setActiveTab(o)}}}),this.updateComplete.then(()=>{this.syncTabsAndPanels(),this.mutationObserver.observe(this,{attributes:!0,attributeFilter:["active","disabled","name","panel"],childList:!0,subtree:!0}),this.resizeObserver.observe(this.nav),e.then(()=>{new IntersectionObserver((s,r)=>{var o;s[0].intersectionRatio>0&&(this.setAriaLabels(),this.setActiveTab((o=this.getActiveTab())!=null?o:this.tabs[0],{emitEvents:!1}),r.unobserve(s[0].target))}).observe(this.tabGroup)})})}disconnectedCallback(){var e,t;super.disconnectedCallback(),(e=this.mutationObserver)==null||e.disconnect(),this.nav&&((t=this.resizeObserver)==null||t.unobserve(this.nav))}getAllTabs(){return this.shadowRoot.querySelector('slot[name="nav"]').assignedElements()}getAllPanels(){return[...this.body.assignedElements()].filter(e=>e.tagName.toLowerCase()==="sl-tab-panel")}getActiveTab(){return this.tabs.find(e=>e.active)}handleClick(e){let s=e.target.closest("sl-tab");s?.closest("sl-tab-group")===this&&s!==null&&this.setActiveTab(s,{scrollBehavior:"smooth"})}handleKeyDown(e){let s=e.target.closest("sl-tab");if(s?.closest("sl-tab-group")===this&&(["Enter"," "].includes(e.key)&&s!==null&&(this.setActiveTab(s,{scrollBehavior:"smooth"}),e.preventDefault()),["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key))){let o=this.tabs.find(n=>n.matches(":focus")),i=this.localize.dir()==="rtl",a=null;if(o?.tagName.toLowerCase()==="sl-tab"){if(e.key==="Home")a=this.focusableTabs[0];else if(e.key==="End")a=this.focusableTabs[this.focusableTabs.length-1];else if(["top","bottom"].includes(this.placement)&&e.key===(i?"ArrowRight":"ArrowLeft")||["start","end"].includes(this.placement)&&e.key==="ArrowUp"){let n=this.tabs.findIndex(l=>l===o);a=this.findNextFocusableTab(n,"backward")}else if(["top","bottom"].includes(this.placement)&&e.key===(i?"ArrowLeft":"ArrowRight")||["start","end"].includes(this.placement)&&e.key==="ArrowDown"){let n=this.tabs.findIndex(l=>l===o);a=this.findNextFocusableTab(n,"forward")}if(!a)return;a.tabIndex=0,a.focus({preventScroll:!0}),this.activation==="auto"?this.setActiveTab(a,{scrollBehavior:"smooth"}):this.tabs.forEach(n=>{n.tabIndex=n===a?0:-1}),["top","bottom"].includes(this.placement)&&zt(a,this.nav,"horizontal"),e.preventDefault()}}}handleScrollToStart(){this.nav.scroll({left:this.localize.dir()==="rtl"?this.nav.scrollLeft+this.nav.clientWidth:this.nav.scrollLeft-this.nav.clientWidth,behavior:"smooth"})}handleScrollToEnd(){this.nav.scroll({left:this.localize.dir()==="rtl"?this.nav.scrollLeft-this.nav.clientWidth:this.nav.scrollLeft+this.nav.clientWidth,behavior:"smooth"})}setActiveTab(e,t){if(t=W({emitEvents:!0,scrollBehavior:"auto"},t),e!==this.activeTab&&!e.disabled){let s=this.activeTab;this.activeTab=e,this.tabs.forEach(r=>{r.active=r===this.activeTab,r.tabIndex=r===this.activeTab?0:-1}),this.panels.forEach(r=>{var o;return r.active=r.name===((o=this.activeTab)==null?void 0:o.panel)}),this.syncIndicator(),["top","bottom"].includes(this.placement)&&zt(this.activeTab,this.nav,"horizontal",t.scrollBehavior),t.emitEvents&&(s&&this.emit("sl-tab-hide",{detail:{name:s.panel}}),this.emit("sl-tab-show",{detail:{name:this.activeTab.panel}}))}}setAriaLabels(){this.tabs.forEach(e=>{let t=this.panels.find(s=>s.name===e.panel);t&&(e.setAttribute("aria-controls",t.getAttribute("id")),t.setAttribute("aria-labelledby",e.getAttribute("id")))})}repositionIndicator(){let e=this.getActiveTab();if(!e)return;let t=e.clientWidth,s=e.clientHeight,r=this.localize.dir()==="rtl",o=this.getAllTabs(),a=o.slice(0,o.indexOf(e)).reduce((n,l)=>({left:n.left+l.clientWidth,top:n.top+l.clientHeight}),{left:0,top:0});switch(this.placement){case"top":case"bottom":this.indicator.style.width=`${t}px`,this.indicator.style.height="auto",this.indicator.style.translate=r?`${-1*a.left}px`:`${a.left}px`;break;case"start":case"end":this.indicator.style.width="auto",this.indicator.style.height=`${s}px`,this.indicator.style.translate=`0 ${a.top}px`;break}}syncTabsAndPanels(){this.tabs=this.getAllTabs(),this.focusableTabs=this.tabs.filter(e=>!e.disabled),this.panels=this.getAllPanels(),this.syncIndicator(),this.updateComplete.then(()=>this.updateScrollControls())}findNextFocusableTab(e,t){let s=null,r=t==="forward"?1:-1,o=e+r;for(;e<this.tabs.length;){if(s=this.tabs[o]||null,s===null){t==="forward"?s=this.focusableTabs[0]:s=this.focusableTabs[this.focusableTabs.length-1];break}if(!s.disabled)break;o+=r}return s}updateScrollButtons(){this.hasScrollControls&&!this.fixedScrollControls&&(this.shouldHideScrollStartButton=this.scrollFromStart()<=this.scrollOffset,this.shouldHideScrollEndButton=this.isScrolledToEnd())}isScrolledToEnd(){return this.scrollFromStart()+this.nav.clientWidth>=this.nav.scrollWidth-this.scrollOffset}scrollFromStart(){return this.localize.dir()==="rtl"?-this.nav.scrollLeft:this.nav.scrollLeft}updateScrollControls(){this.noScrollControls?this.hasScrollControls=!1:this.hasScrollControls=["top","bottom"].includes(this.placement)&&this.nav.scrollWidth>this.nav.clientWidth+1,this.updateScrollButtons()}syncIndicator(){this.getActiveTab()?(this.indicator.style.display="block",this.repositionIndicator()):this.indicator.style.display="none"}show(e){let t=this.tabs.find(s=>s.panel===e);t&&this.setActiveTab(t,{scrollBehavior:"smooth"})}render(){let e=this.localize.dir()==="rtl";return g`
      <div
        part="base"
        class=${P({"tab-group":!0,"tab-group--top":this.placement==="top","tab-group--bottom":this.placement==="bottom","tab-group--start":this.placement==="start","tab-group--end":this.placement==="end","tab-group--rtl":this.localize.dir()==="rtl","tab-group--has-scroll-controls":this.hasScrollControls})}
        @click=${this.handleClick}
        @keydown=${this.handleKeyDown}
      >
        <div class="tab-group__nav-container" part="nav">
          ${this.hasScrollControls?g`
                <sl-icon-button
                  part="scroll-button scroll-button--start"
                  exportparts="base:scroll-button__base"
                  class=${P({"tab-group__scroll-button":!0,"tab-group__scroll-button--start":!0,"tab-group__scroll-button--start--hidden":this.shouldHideScrollStartButton})}
                  name=${e?"chevron-right":"chevron-left"}
                  library="system"
                  tabindex="-1"
                  aria-hidden="true"
                  label=${this.localize.term("scrollToStart")}
                  @click=${this.handleScrollToStart}
                ></sl-icon-button>
              `:""}

          <div class="tab-group__nav" @scrollend=${this.updateScrollButtons}>
            <div part="tabs" class="tab-group__tabs" role="tablist">
              <div part="active-tab-indicator" class="tab-group__indicator"></div>
              <sl-resize-observer @sl-resize=${this.syncIndicator}>
                <slot name="nav" @slotchange=${this.syncTabsAndPanels}></slot>
              </sl-resize-observer>
            </div>
          </div>

          ${this.hasScrollControls?g`
                <sl-icon-button
                  part="scroll-button scroll-button--end"
                  exportparts="base:scroll-button__base"
                  class=${P({"tab-group__scroll-button":!0,"tab-group__scroll-button--end":!0,"tab-group__scroll-button--end--hidden":this.shouldHideScrollEndButton})}
                  name=${e?"chevron-left":"chevron-right"}
                  library="system"
                  tabindex="-1"
                  aria-hidden="true"
                  label=${this.localize.term("scrollToEnd")}
                  @click=${this.handleScrollToEnd}
                ></sl-icon-button>
              `:""}
        </div>

        <slot part="body" class="tab-group__body" @slotchange=${this.syncTabsAndPanels}></slot>
      </div>
    `}};b.styles=[w,$e];b.dependencies={"sl-icon-button":y,"sl-resize-observer":st};c([C(".tab-group")],b.prototype,"tabGroup",2);c([C(".tab-group__body")],b.prototype,"body",2);c([C(".tab-group__nav")],b.prototype,"nav",2);c([C(".tab-group__indicator")],b.prototype,"indicator",2);c([R()],b.prototype,"hasScrollControls",2);c([R()],b.prototype,"shouldHideScrollStartButton",2);c([R()],b.prototype,"shouldHideScrollEndButton",2);c([h()],b.prototype,"placement",2);c([h()],b.prototype,"activation",2);c([h({attribute:"no-scroll-controls",type:Boolean})],b.prototype,"noScrollControls",2);c([h({attribute:"fixed-scroll-controls",type:Boolean})],b.prototype,"fixedScrollControls",2);c([we({passive:!0})],b.prototype,"updateScrollButtons",1);c([_("noScrollControls",{waitUntilFirstUpdate:!0})],b.prototype,"updateScrollControls",1);c([_("placement",{waitUntilFirstUpdate:!0})],b.prototype,"syncIndicator",1);b.define("sl-tab-group");var ds=(e,t)=>{let s=0;return function(...r){window.clearTimeout(s),s=window.setTimeout(()=>{e.call(this,...r)},t)}},He=(e,t,s)=>{let r=e[t];e[t]=function(...o){r.call(this,...o),s.call(this,r,...o)}};(()=>{if(typeof window>"u")return;if(!("onscrollend"in window)){let t=new Set,s=new WeakMap,r=i=>{for(let a of i.changedTouches)t.add(a.identifier)},o=i=>{for(let a of i.changedTouches)t.delete(a.identifier)};document.addEventListener("touchstart",r,!0),document.addEventListener("touchend",o,!0),document.addEventListener("touchcancel",o,!0),He(EventTarget.prototype,"addEventListener",function(i,a){if(a!=="scrollend")return;let n=ds(()=>{t.size?n():this.dispatchEvent(new Event("scrollend"))},100);i.call(this,"scroll",n,{passive:!0}),s.set(this,n)}),He(EventTarget.prototype,"removeEventListener",function(i,a){if(a!=="scrollend")return;let n=s.get(this);n&&i.call(this,"scroll",n,{passive:!0})})}})();var Ue=v`
  :host {
    display: inline-block;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    font-family: var(--sl-font-sans);
    font-size: var(--sl-font-size-small);
    font-weight: var(--sl-font-weight-semibold);
    border-radius: var(--sl-border-radius-medium);
    color: var(--sl-color-neutral-600);
    padding: var(--sl-spacing-medium) var(--sl-spacing-large);
    white-space: nowrap;
    user-select: none;
    -webkit-user-select: none;
    cursor: pointer;
    transition:
      var(--transition-speed) box-shadow,
      var(--transition-speed) color;
  }

  .tab:hover:not(.tab--disabled) {
    color: var(--sl-color-primary-600);
  }

  :host(:focus) {
    outline: transparent;
  }

  :host(:focus-visible) {
    color: var(--sl-color-primary-600);
    outline: var(--sl-focus-ring);
    outline-offset: calc(-1 * var(--sl-focus-ring-width) - var(--sl-focus-ring-offset));
  }

  .tab.tab--active:not(.tab--disabled) {
    color: var(--sl-color-primary-600);
  }

  .tab.tab--closable {
    padding-inline-end: var(--sl-spacing-small);
  }

  .tab.tab--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tab__close-button {
    font-size: var(--sl-font-size-small);
    margin-inline-start: var(--sl-spacing-small);
  }

  .tab__close-button::part(base) {
    padding: var(--sl-spacing-3x-small);
  }

  @media (forced-colors: active) {
    .tab.tab--active:not(.tab--disabled) {
      outline: solid 1px transparent;
      outline-offset: -3px;
    }
  }
`;var hs=0,S=class extends m{constructor(){super(...arguments),this.localize=new q(this),this.attrId=++hs,this.componentId=`sl-tab-${this.attrId}`,this.panel="",this.active=!1,this.closable=!1,this.disabled=!1,this.tabIndex=0}connectedCallback(){super.connectedCallback(),this.setAttribute("role","tab")}handleCloseClick(e){e.stopPropagation(),this.emit("sl-close")}handleActiveChange(){this.setAttribute("aria-selected",this.active?"true":"false")}handleDisabledChange(){this.setAttribute("aria-disabled",this.disabled?"true":"false"),this.disabled&&!this.active?this.tabIndex=-1:this.tabIndex=0}render(){return this.id=this.id.length>0?this.id:this.componentId,g`
      <div
        part="base"
        class=${P({tab:!0,"tab--active":this.active,"tab--closable":this.closable,"tab--disabled":this.disabled})}
      >
        <slot></slot>
        ${this.closable?g`
              <sl-icon-button
                part="close-button"
                exportparts="base:close-button__base"
                name="x-lg"
                library="system"
                label=${this.localize.term("close")}
                class="tab__close-button"
                @click=${this.handleCloseClick}
                tabindex="-1"
              ></sl-icon-button>
            `:""}
      </div>
    `}};S.styles=[w,Ue];S.dependencies={"sl-icon-button":y};c([C(".tab")],S.prototype,"tab",2);c([h({reflect:!0})],S.prototype,"panel",2);c([h({type:Boolean,reflect:!0})],S.prototype,"active",2);c([h({type:Boolean,reflect:!0})],S.prototype,"closable",2);c([h({type:Boolean,reflect:!0})],S.prototype,"disabled",2);c([h({type:Number,reflect:!0})],S.prototype,"tabIndex",2);c([_("active")],S.prototype,"handleActiveChange",1);c([_("disabled")],S.prototype,"handleDisabledChange",1);S.define("sl-tab");var De=v`
  :host {
    --padding: 0;

    display: none;
  }

  :host([active]) {
    display: block;
  }

  .tab-panel {
    display: block;
    padding: var(--padding);
  }
`;var ps=0,G=class extends m{constructor(){super(...arguments),this.attrId=++ps,this.componentId=`sl-tab-panel-${this.attrId}`,this.name="",this.active=!1}connectedCallback(){super.connectedCallback(),this.id=this.id.length>0?this.id:this.componentId,this.setAttribute("role","tabpanel")}handleActiveChange(){this.setAttribute("aria-hidden",this.active?"false":"true")}render(){return g`
      <slot
        part="base"
        class=${P({"tab-panel":!0,"tab-panel--active":this.active})}
      ></slot>
    `}};G.styles=[w,De];c([h({reflect:!0})],G.prototype,"name",2);c([h({type:Boolean,reflect:!0})],G.prototype,"active",2);c([_("active")],G.prototype,"handleActiveChange",1);G.define("sl-tab-panel");var Fe=["MessageSquare","FileText","CheckCheck","Image","Globe","Plus","Send","Square","PanelRightClose","Paperclip","ArrowUpRight","History","Settings","Search","RotateCcw","Archive","Pencil","Copy","ChevronDown","LoaderCircle","MessageCircleQuestion","CircleAlert","Check","FilePlus2","FilePenLine","Save","GitBranch","Trash2"];Fe.push("PanelLeftClose","ListTodo","BookOpen","CircleUserRound","SlidersHorizontal");window.iceComponents={icons:()=>window.lucide.createIcons({icons:Object.fromEntries(Fe.map(e=>[e,window.lucide[e]]))})};})();
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
@lit/reactive-element/decorators/custom-element.js:
@lit/reactive-element/decorators/property.js:
@lit/reactive-element/decorators/state.js:
@lit/reactive-element/decorators/event-options.js:
@lit/reactive-element/decorators/base.js:
@lit/reactive-element/decorators/query.js:
@lit/reactive-element/decorators/query-all.js:
@lit/reactive-element/decorators/query-async.js:
@lit/reactive-element/decorators/query-assigned-nodes.js:
lit-html/directive.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/decorators/query-assigned-elements.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/directives/if-defined.js:
lit-html/directives/class-map.js:
  (**
   * @license
   * Copyright 2018 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/directive-helpers.js:
lit-html/static.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
