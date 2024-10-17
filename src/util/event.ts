export default class EventEmitter{
    private listerMap;
    constructor(){
        this.listerMap = [];
    }
    on(eventName: string, listener: Function){
        this.listerMap.push({eventName, listener});
    }
    emit(eventName: string, ...param){
        const emitter = this.listerMap.indexOf(eventName);
        emitter.listener(param);
    }
}