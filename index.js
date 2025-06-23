
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class WordCounterManager {
    constructor(maxWorkers = null) {
        // Usar número óptimo de workers basado en CPUs disponibles
        this.maxWorkers = maxWorkers || Math.min(os.cpus().length, 4);
        this.activeWorkers = 0;
        this.fileQueue = [];
        this.results = new Map();
        this.errors = [];
        this.totalFiles = 0;
        this.completedFiles = 0;
    }

    /**
     * Procesa múltiples archivos en paralelo
     * @param {string[]} filePaths - Array de rutas de archivos
     * @returns {Promise<Object>} Resultados consolidados
     */
    async processFiles(filePaths) {
        this.totalFiles = filePaths.length;
        this.fileQueue = [...filePaths];
        
        console.log(` Iniciando procesamiento de ${this.totalFiles} archivo(s)`);
        console.log(` Usando ${this.maxWorkers} worker(s) en paralelo`);
        console.log('─'.repeat(60));

        // Iniciar workers hasta el máximo permitido
        const workerPromises = [];
        for (let i = 0; i < Math.min(this.maxWorkers, this.fileQueue.length); i++) {
            workerPromises.push(this.startWorker());
        }

        // Esperar a que todos los workers terminen
        await Promise.all(workerPromises);

        return this.consolidateResults();
    }

    /**
     * Inicia un worker thread para procesar archivos
     */
    async startWorker() {
        while (this.fileQueue.length > 0) {
            const filePath = this.fileQueue.shift();
            this.activeWorkers++;

            try {
                console.log(` Procesando: ${path.basename(filePath)}`);
                
                const worker = new Worker(__filename, {
                    workerData: { filePath, isWorker: true }
                });

                const result = await new Promise((resolve, reject) => {
                    worker.on('message', resolve);
                    worker.on('error', reject);
                    worker.on('exit', (code) => {
                        if (code !== 0) {
                            reject(new Error(`Worker terminó con código ${code}`));
                        }
                    });
                });

                // Consolidar resultados
                this.mergeWordCounts(result.wordCounts);
                this.completedFiles++;
                
                console.log(` Completado: ${path.basename(filePath)} (${result.totalWords.toLocaleString()} palabras, ${result.uniqueWords.toLocaleString()} únicas)`);
                
            } catch (error) {
                this.errors.push({
                    file: filePath,
                    error: error.message
                });
                console.error(` Error procesando ${path.basename(filePath)}: ${error.message}`);
            } finally {
                this.activeWorkers--;
            }
        }
    }

    /**
     * Combina conteos de palabras de múltiples archivos
     * @param {Map} newCounts - Nuevos conteos para agregar
     */
    mergeWordCounts(newCounts) {
        for (const [word, count] of newCounts) {
            this.results.set(word, (this.results.get(word) || 0) + count);
        }
    }

    /**
     * Consolida y formatea los resultados finales
     */
    consolidateResults() {
        const sortedWords = Array.from(this.results.entries())
            .sort((a, b) => b[1] - a[1]);

        const top10 = sortedWords.slice(0, 10);
        const totalWords = sortedWords.reduce((sum, [, count]) => sum + count, 0);
        const uniqueWords = sortedWords.length;

        return {
            top10Words: top10,
            totalWords,
            uniqueWords,
            filesProcessed: this.completedFiles,
            errors: this.errors
        };
    }

    /**
     * Muestra los resultados 
     */
    displayResults(results) {
        console.log('\n' + '='.repeat(60));
        console.log(' RESULTADOS FINALES');
        console.log('='.repeat(60));
        
        console.log(`Archivos procesados: ${results.filesProcessed}/${this.totalFiles}`);
        console.log(`Total de palabras: ${results.totalWords.toLocaleString()}`);
        console.log(`Palabras únicas: ${results.uniqueWords.toLocaleString()}`);
        
        if (results.errors.length > 0) {
            console.log(`  Errores: ${results.errors.length}`);
        }

        console.log('\n TOP 10 PALABRAS MÁS FRECUENTES:');
        console.log('─'.repeat(40));
        
        results.top10Words.forEach(([word, count], index) => {
            const percentage = ((count / results.totalWords) * 100).toFixed(2);
            console.log(`${(index + 1).toString().padStart(2)}. ${word.padEnd(15)} ${count.toLocaleString().padStart(8)} (${percentage}%)`);
        });

        if (results.errors.length > 0) {
            console.log('\n  ERRORES ENCONTRADOS:');
            console.log('─'.repeat(40));
            results.errors.forEach(({ file, error }) => {
                console.log(` ${path.basename(file)}: ${error}`);
            });
        }
    }
}



if (!isMainThread && workerData && workerData.isWorker) {
    const readline = require('readline');
    const fs = require('fs');

    /**
     * Worker que procesa un archivo individual usando streams
     */
    async function processFileInWorker(filePath) {
        const wordCounts = new Map();
        let totalWords = 0;

        try {
            // Verificar que el archivo existe
            await fs.promises.access(filePath);
            
            const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity // Para manejar Windows line endings
            });

            // Procesar línea por línea
            for await (const line of rl) {
                const words = extractWords(line);
                
                for (const word of words) {
                    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
                    totalWords++;
                }
            }

            // Convertir Map a array para serialización
            const serializedCounts = Array.from(wordCounts.entries());
            
            parentPort.postMessage({
                wordCounts: new Map(serializedCounts),
                totalWords,
                uniqueWords: wordCounts.size
            });

        } catch (error) {
            parentPort.postMessage({
                error: error.message,
                wordCounts: new Map(),
                totalWords: 0,
                uniqueWords: 0
            });
        }
    }

    /**
     * Extrae y limpia palabras de una línea de texto
     * @param {string} line - Línea de texto
     * @returns {string[]} Array de palabras limpias
     */
    function extractWords(line) {
        return line
            .toLowerCase()
            .replace(/[^\w\sáéíóúñü]/g, '') // Remover puntuación, mantener acentos
            .split(/\s+/) // Dividir por espacios
            .filter(word => word.length > 0 && word.length > 1); // Filtrar palabras vacías y de 1 letra
    }

    // Ejecutar el worker
    processFileInWorker(workerData.filePath);
}

if (isMainThread) {
    /**
     * Función principal
     */
    async function main() {
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            console.log(' Contador de Palabras Paralelo ');
            console.log('');
            console.log('Uso: node index.js [archivo1] [archivo2] [...]');
            console.log('');
            console.log('Ejemplos:');
            console.log('  node index.js libro.txt');
            console.log('  node index.js *.txt');
            console.log('  node index.js libro1.txt libro2.txt libro3.txt');
            console.log('');
            process.exit(1);
        }

        // Verificar archivos
        const validFiles = [];
        for (const filePath of args) {
            try {
                await fs.access(filePath);
                validFiles.push(filePath);
            } catch {
                console.error(` Archivo no encontrado: ${filePath}`);
            }
        }

        if (validFiles.length === 0) {
            console.error(' No se encontraron archivos válidos para procesar');
            process.exit(1);
        }

        // Procesar archivos
        const startTime = Date.now();
        const manager = new WordCounterManager();
        
        try {
            const results = await manager.processFiles(validFiles);
            const endTime = Date.now();
            const duration = (endTime - startTime) / 1000;
            
            manager.displayResults(results);
            
            console.log(`\n  Tiempo total: ${duration.toFixed(2)} segundos`);
            console.log(` Velocidad: ${(results.totalWords / duration).toFixed(0)} palabras/segundo`);
            
        } catch (error) {
            console.error('Error fatal:', error.message);
            process.exit(1);
        }
    }

    // Manejo elegante de errores y señales
    process.on('uncaughtException', (error) => {
        console.error(' Error no capturado:', error.message);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error(' Promesa rechazada:', reason);
        process.exit(1);
    });

    process.on('SIGINT', () => {
        console.log('\n Proceso interrumpido por el usuario');
        process.exit(0);
    });

    // Ejecutar programa principal
    main().catch(console.error);
}