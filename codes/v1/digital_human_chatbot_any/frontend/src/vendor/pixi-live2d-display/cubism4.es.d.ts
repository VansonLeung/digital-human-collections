import { Container, Ticker } from 'pixi.js';
export const config: { sound:boolean };
export class Live2DModel extends Container {
  static registerTicker(ticker:typeof Ticker):void;
  static from(url:string, options?:{autoInteract?:boolean;autoUpdate?:boolean}):Promise<Live2DModel>;
  anchor:{set:(x:number,y?:number)=>void};
  internalModel:{on:(event:string,listener:()=>void)=>void;coreModel:{setParameterValueById:(id:string,value:number)=>void;addParameterValueById:(id:string,value:number,weight?:number)=>void}};
  update(deltaMS:number):void;
}
