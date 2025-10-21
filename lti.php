<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Mi Herramienta LTI</title>
    <style>
        body { font-family: sans-serif; padding: 2em; }
        pre { background-color: #f4f4f4; padding: 1em; border-radius: 5px; }
    </style>
</head>
<body>
    <h1>¡Conexión LTI Recibida!</h1>

    <?php
    // La variable $_POST en PHP contiene todos los datos enviados por Canvas.
    // Verificamos si la variable no está vacía.
    if (!empty($_POST)) {
        echo "<p>¡Hola, <strong>" . htmlspecialchars($_POST['lis_person_name_full'] ?? 'Usuario de Canvas') . "</strong>!</p>";
        echo "<p>Has lanzado esta herramienta desde el curso: <strong>" . htmlspecialchars($_POST['context_title'] ?? 'Curso Desconocido') . "</strong>.</p>";
        echo "<h3>Detalles completos recibidos de Canvas:</h3>";
        echo "<pre>";
        // Imprimimos todos los datos que nos envió Canvas para inspeccionarlos.
        print_r($_POST);
        echo "</pre>";
    } else {
        echo "<p>Esta es la página de mi herramienta LTI. Parece que has llegado directamente sin pasar por Canvas.</p>";
    }
    ?>

</body>
</html>